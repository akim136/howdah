import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ComparisonSummary } from "./comparison.js";
import { CASE, groundingResponse, rubricResponse } from "./test-fixtures.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(cases: unknown = [CASE], args: string[] = [], key = "test-key", fault?: "output-file" | "later-trial") {
  const directory = mkdtempSync(join(tmpdir(), "howdah-compare-cli-"));
  directories.push(directory);
  const dataset = join(directory, "cases.json"), output = join(directory, "output"), marker = join(directory, "calls.jsonl"), preload = join(directory, "preload.mjs");
  writeFileSync(dataset, typeof cases === "string" ? cases : JSON.stringify(cases));
  if (fault === "output-file") writeFileSync(output, "preserve this file");
  // All child requests terminate in this mock. Record model/kind only, never keys or payloads.
  writeFileSync(preload, `import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let blocked = false;
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body);
  const input = JSON.parse(request.messages[0].content);
  const grounding = Boolean(request.output_config.format.schema.properties.unsupported);
  appendFileSync(${JSON.stringify(marker)}, JSON.stringify({model: request.model, kind: grounding ? 'grounding' : 'rubric'}) + '\\n');
  if (${fault === "later-trial"} && request.model === 'claude-sonnet-4-6' && !blocked) {
    const staging = readdirSync(${JSON.stringify(output)}).find(n => n.startsWith('.comparison-'));
    writeFileSync(join(${JSON.stringify(output)}, staging, 'sonnet-trial-001'), 'block publication');
    blocked = true;
  }
  if (input.answer === 'error') return new Response('private upstream response', {status: 401});
  const result = grounding ? ${JSON.stringify(groundingResponse())} : ${JSON.stringify(rubricResponse())};
  if (input.answer === 'unfaithful') {
    if (grounding) result.unsupported = ['unsupported statement'];
    else result.flags = ['unsupported statement'];
  }
  return Response.json({model: request.model, stop_reason: 'end_turn', usage: {input_tokens: 10, output_tokens: 2},
    content: [{type: 'text', text: JSON.stringify(result)}]});
};
`);
  const child = spawnSync(process.execPath, ["--import", preload, "--import", "tsx", "src/compare.ts", "--dataset", dataset, "--output-dir", output, ...args],
    { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, ANTHROPIC_API_KEY: key } });
  if (child.error) throw child.error;
  const entries = existsSync(output) && fault !== "output-file" ? readdirSync(output) : [];
  const published = entries.filter((name) => name.startsWith("comparison-"));
  const requests = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { model: string; kind: string }) : [];
  return { ...child, output, requests, entries, published,
    summary: () => JSON.parse(readFileSync(join(output, published[0]!, "comparison.json"), "utf8")) as ComparisonSummary,
    artifact: (path: string) => readFileSync(join(output, published[0]!, path), "utf8"),
  };
}

describe("comparison CLI", () => {
  it("runs all strategies on identical cases, records order and costs, and publishes every trial", () => {
    const child = fixture([CASE], ["--trials", "3", "--pricing", "pricing/anthropic-standard.json", "--quiet"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.published).toHaveLength(1);
    expect(child.entries).toHaveLength(1);
    const summary = child.summary();
    expect(summary.metadata).toMatchObject({ cases: 1, trialsPerStrategy: 3, strategies: ["haiku", "sonnet", "cascade"] });
    expect(summary.metadata.executionOrder.map((r) => r.strategy)).toEqual(["haiku", "sonnet", "cascade", "sonnet", "cascade", "haiku", "cascade", "haiku", "sonnet"]);
    expect(child.requests).toHaveLength(18);
    expect(summary.strategies.map((s) => s.usage.attempts)).toEqual([6, 6, 6]);
    expect(summary.strategies[0]!.cost.knownUsd).toBeCloseTo(0.00012);
    expect(summary.strategies[1]!.cost.knownUsd).toBeCloseTo(0.00036);
    expect(summary.strategies.every((s) => s.repeatability.agreement === 1 && s.pooledMetrics.coverage === 1)).toBe(true);
    const manifest = JSON.parse(child.artifact("manifest.json"));
    expect(manifest.status).toBe("complete");
    expect(manifest.runs).toHaveLength(9);
    for (const run of manifest.runs) {
      const result = JSON.parse(child.artifact(run.files[0].path));
      expect(result.metadata.strategy).toBe(run.strategy);
      expect(result.metadata.trial).toBe(run.trial);
      expect(result.metadata.dataset.sha256).toBe(summary.metadata.dataset.sha256);
      expect(result.rows.map((r: { id: string }) => r.id)).toEqual([CASE.id]);
    }
    expect(child.artifact("comparison.md")).toContain("# Model comparison");
  });

  it("preserves mixed outcomes, errors and abstentions across all strategies and exits nonzero", () => {
    const child = fixture([CASE, { ...CASE, id: "bad", answer: "error" }, { ...CASE, id: "empty", answer: "" },
      { ...CASE, id: "unsupported", answer: "unfaithful", label: "unfaithful" }], ["--trials", "2", "--quiet"]);
    expect(child.status).toBe(1);
    expect(child.published).toHaveLength(1);
    for (const strategy of child.summary().strategies) {
      expect(strategy.pooledMetrics).toMatchObject({ total: 8, classified: 4, errors: 2, abstained: 2, accuracy: 1, coverage: 0.5 });
      expect(strategy.repeatability).toMatchObject({ possiblePairs: 4, eligiblePairs: 3, agreeingPairs: 3, agreement: 1, pairCoverage: 0.75 });
    }
    expect(child.summary().strategies[2]?.pooledMetrics.escalated).toBe(2);
    expect(child.artifact("comparison.md")).not.toContain("private upstream response");
    expect(child.stderr).not.toContain("test-key");
  });

  it("keeps all-error trials with undefined metrics and no successful agreement", () => {
    const child = fixture([{ ...CASE, answer: "error" }], ["--trials", "2", "--quiet", "--pricing", "pricing/anthropic-standard.json"]);
    expect(child.status).toBe(1);
    expect(child.requests).toHaveLength(6);
    for (const strategy of child.summary().strategies) {
      expect(strategy.pooledMetrics).toMatchObject({ errors: 2, coverage: 0, accuracy: null, f1: null });
      expect(strategy.repeatability).toMatchObject({ eligiblePairs: 0, agreement: null, pairCoverage: 0 });
      expect(strategy.cost).toMatchObject({ complete: false, missingUsageAttempts: 2 });
    }
  });

  it("checks-only never makes requests and never treats skipped trials as agreement", () => {
    const child = fixture([CASE], ["--checks-only", "--quiet", "--trials", "2"], "");
    expect(child.status).toBe(0);
    expect(child.requests).toEqual([]);
    for (const strategy of child.summary().strategies) {
      expect(strategy.pooledMetrics).toMatchObject({ skipped: 2, coverage: 0, accuracy: null });
      expect(strategy.repeatability).toMatchObject({ eligiblePairs: 0, agreement: null });
    }
  });

  it("accepts a single strategy without an unnecessary screen or escalation", () => {
    const child = fixture([CASE], ["--strategies", "sonnet", "--trials", "1"]);
    expect(child.status).toBe(0);
    expect(child.requests.map((r) => r.model)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6"]);
    expect(child.summary().strategies[0]?.pooledMetrics.escalated).toBe(0);
    expect(child.stdout).toContain("# Model comparison");
  });

  it.each([
    { cases: [CASE], args: ["--trials", "0"], key: "test" },
    { cases: [CASE], args: ["--strategies", "haiku,haiku"], key: "test" },
    { cases: [CASE], args: ["--pricing", "missing-pricing.json"], key: "test" },
    { cases: [CASE, CASE], args: [], key: "test" },
    { cases: [CASE], args: [], key: "" },
  ])("fails invalid input or credentials before requests or artifact creation (%#)", ({ cases, args, key }) => {
    const child = fixture(cases, args, key);
    expect(child.status).toBe(1);
    expect(child.requests).toEqual([]);
    expect(child.entries).toEqual([]);
  });

  it("fails an unusable output parent before paid calls", () => {
    const child = fixture([CASE], [], "test", "output-file");
    expect(child.status).toBe(1);
    expect(child.requests).toEqual([]);
    expect(readFileSync(child.output, "utf8")).toBe("preserve this file");
  });

  it("preserves the first completed trial if later publication fails, with a failed manifest", () => {
    const child = fixture([CASE], ["--trials", "1", "--quiet"], "test", "later-trial");
    expect(child.status).toBe(1);
    expect(child.published).toHaveLength(0);
    expect(child.requests).toHaveLength(4);
    const staging = child.entries.find((name) => name.startsWith(".comparison-"))!;
    const manifest = JSON.parse(readFileSync(join(child.output, staging, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("failed");
    expect(manifest.runs).toHaveLength(1);
    expect(existsSync(join(child.output, staging, "haiku-trial-001/results.json"))).toBe(true);
    expect(child.stderr).toContain("Partial artifacts remain");
  });
});
