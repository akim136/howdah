import { readFileSync } from "node:fs";
import type { Row } from "./types.js";
import { isRecord, nonemptyString } from "./validation.js";

export interface Rates {
  input: number; output: number; cacheRead: number | null; cacheCreation: number | null;
}
export interface Pricing {
  currency: "USD"; asOf: string; source: string; rates: Record<string, Rates>;
}

export function parsePricing(value: unknown): Pricing {
  const fail = () => new Error("Invalid pricing: require USD, an asOf date, HTTPS source, and nonnegative finite per-million token rates (cache rates may be null).");
  if (!isRecord(value) || value.currency !== "USD" || !nonemptyString(value.source) || !value.source.startsWith("https://")
    || typeof value.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf) || !Number.isFinite(Date.parse(value.asOf))
    || !isRecord(value.rates) || Object.keys(value.rates).length === 0) throw fail();
  if (new Date(value.asOf).toISOString().slice(0, 10) !== value.asOf) throw fail();
  try { if (new URL(value.source).protocol !== "https:") throw fail(); }
  catch { throw fail(); }
  const rates: Record<string, Rates> = Object.create(null) as Record<string, Rates>;
  for (const [model, rate] of Object.entries(value.rates)) {
    if (!/^claude-[a-zA-Z0-9.-]+$/.test(model) || !isRecord(rate)) throw fail();
    for (const key of ["input", "output", "cacheRead", "cacheCreation"] as const) {
      const n = rate[key];
      if ((key === "cacheRead" || key === "cacheCreation") && n === null) continue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw fail();
    }
    rates[model] = { input: rate.input as number, output: rate.output as number,
      cacheRead: rate.cacheRead as number | null, cacheCreation: rate.cacheCreation as number | null };
  }
  return { currency: "USD", asOf: value.asOf, source: value.source, rates };
}

export function readPricing(path: string): Pricing {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Cannot read pricing file as JSON."); }
  return parsePricing(value);
}

/** Known subtotal only: missing usage or any needed rate makes the estimate incomplete. */
export function estimateCost(rows: Row[], pricing: Pricing | null) {
  let knownUsd = 0, missingUsageAttempts = 0, unpricedAttempts = 0;
  const stages = rows.flatMap((r) => r.evaluation?.stages ?? []);
  for (const stage of stages) {
    for (const attempt of stage.attempts) {
      if (!attempt.usage) { missingUsageAttempts++; continue; }
      const rates = pricing?.rates[stage.model];
      if (!rates) { unpricedAttempts++; continue; }
      const u = attempt.usage;
      const amounts = [[u.inputTokens, rates.input], [u.outputTokens, rates.output],
        [u.cacheReadInputTokens, rates.cacheRead], [u.cacheCreationInputTokens, rates.cacheCreation]] as const;
      if (amounts.some(([tokens, rate]) => tokens > 0 && rate === null)) unpricedAttempts++;
      for (const [tokens, rate] of amounts) if (rate !== null) knownUsd += tokens * rate / 1_000_000;
    }
  }
  // A malformed/extreme supplied price must not silently serialize an infinite estimate as null.
  if (!Number.isFinite(knownUsd)) throw new Error("Estimated cost overflow; check pricing rates.");
  return { knownUsd: pricing ? knownUsd : null, complete: pricing !== null && missingUsageAttempts === 0 && unpricedAttempts === 0,
    missingUsageAttempts, unpricedAttempts };
}
