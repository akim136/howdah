import { describe, expect, it } from "vitest";
import { outcomeRow } from "./comparison-fixtures.js";
import { judge, MODELS } from "./judge.js";
import { estimateCost, parsePricing, readPricing } from "./pricing.js";
import { FAITHFULNESS } from "./rubric.js";
import { CASE, envelope, groundingResponse, mockFetch, rubricResponse } from "./test-fixtures.js";

const pricing = { currency: "USD", asOf: "2026-09-16", source: "https://example.test/pricing", rates: {
  [MODELS.screen]: { input: 1, output: 5, cacheRead: 0.1, cacheCreation: null },
} };
const rowWithUsage = async () => ({ ...outcomeRow("faithful"), evaluation: await judge(CASE, {
  apiKey: "test", rubric: FAITHFULNESS, strategy: "haiku", fetchImpl: mockFetch([envelope(rubricResponse()), envelope(groundingResponse())]),
}) });

describe("cost estimates", () => {
  it("prices recorded usage across all attempts, including retries with known usage", async () => {
    const row = await rowWithUsage();
    row.evaluation.stages[0]!.attempts.unshift({ ...row.evaluation.stages[0]!.attempts[0]!, errorCode: "OUTPUT_TRUNCATED" });
    const result = estimateCost([row], parsePricing(pricing));
    expect(result).toMatchObject({ complete: true, missingUsageAttempts: 0, unpricedAttempts: 0 });
    expect(result.knownUsd).toBeCloseTo((3 * 123 + 3 * 45 * 5) / 1_000_000);
  });
  it("marks missing usage and rates incomplete while preserving the known subtotal", async () => {
    const row = await rowWithUsage();
    row.evaluation.stages[0]!.attempts[0]!.usage = null;
    expect(estimateCost([row], parsePricing(pricing))).toMatchObject({ complete: false, missingUsageAttempts: 1, unpricedAttempts: 0 });
    row.evaluation.stages[1]!.model = MODELS.escalation;
    expect(estimateCost([row], parsePricing(pricing))).toEqual({ complete: false, knownUsd: 0, missingUsageAttempts: 1, unpricedAttempts: 1 });
    expect(estimateCost([row], null).knownUsd).toBeNull();
  });
  it("does not guess cache-write pricing when the TTL is unknown", async () => {
    const row = await rowWithUsage();
    row.evaluation.stages[0]!.attempts[0]!.usage!.cacheCreationInputTokens = 100;
    row.evaluation.stages[0]!.attempts[0]!.usage!.cacheReadInputTokens = 200;
    const result = estimateCost([row], parsePricing(pricing));
    expect(result).toMatchObject({ complete: false, unpricedAttempts: 1 });
    expect(result.knownUsd).toBeCloseTo((246 + 90 * 5 + 200 * 0.1) / 1_000_000);
    const explicit = parsePricing({ ...pricing, rates: { [MODELS.screen]: { ...pricing.rates[MODELS.screen], cacheCreation: 1.25 } } });
    expect(estimateCost([row], explicit).complete).toBe(true);
    expect(estimateCost([row], explicit).knownUsd).toBeCloseTo(result.knownUsd! + 100 * 1.25 / 1_000_000);
  });
  it("allows genuinely free measured runs, but does not invent a quote without pricing", () => {
    expect(estimateCost([], parsePricing(pricing))).toMatchObject({ knownUsd: 0, complete: true });
    expect(estimateCost([], null)).toMatchObject({ knownUsd: null, complete: false });
  });
  it("rejects arithmetic overflow instead of emitting a misleading null", async () => {
    const row = await rowWithUsage();
    const extreme = parsePricing({ ...pricing, rates: { [MODELS.screen]: { ...pricing.rates[MODELS.screen], input: Number.MAX_VALUE } } });
    expect(() => estimateCost([row], extreme)).toThrow("overflow");
  });
});

describe("pricing validation", () => {
  it.each([null, {}, { ...pricing, currency: "EUR" }, { ...pricing, source: "not a URL" }, { ...pricing, source: "https:// " },
    { ...pricing, asOf: "2026-02-30" }, { ...pricing, asOf: "not-a-date" }, { ...pricing, rates: {} },
    ...[-1, "1", null, Infinity, NaN].map((input) => ({ ...pricing, rates: { [MODELS.screen]: { ...pricing.rates[MODELS.screen], input } } })),
    { ...pricing, rates: { [MODELS.screen]: { input: 1, output: 5 } } },
  ])("rejects invalid price metadata or rates (%#)", (value) => {
    expect(() => parsePricing(value)).toThrow("Invalid pricing");
  });
  it("reads the versioned example with explicit unknown cache-write rates", () => {
    const value = readPricing(new URL("../pricing/anthropic-standard.json", import.meta.url).pathname);
    expect(value.rates[MODELS.screen]).toMatchObject({ input: 1, output: 5, cacheCreation: null });
    expect(value.rates[MODELS.escalation]).toMatchObject({ input: 3, output: 15 });
  });
});
