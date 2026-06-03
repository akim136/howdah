import { describe, expect, it } from "vitest";
import { check, looksLikeRefusal, unsupportedNumbers } from "./checks.js";
import type { Case } from "./types.js";

describe("unsupportedNumbers", () => {
  it("flags numbers in the answer that are absent from the context", () => {
    expect(unsupportedNumbers("The total is 342.", "The total is 318.")).toEqual(["342"]);
  });
  it("treats numbers present in the context as supported (ignoring commas / %)", () => {
    expect(unsupportedNumbers("Up 18% to 12,400.", "signups rose 18% to 12400")).toEqual([]);
  });
});

describe("looksLikeRefusal", () => {
  it("detects an honest 'not in the context' answer", () => {
    expect(looksLikeRefusal("The summary does not break revenue down by region.")).toBe(true);
    expect(looksLikeRefusal("EMEA contributed roughly 4.1M.")).toBe(false);
  });
});

describe("check", () => {
  const base: Case = { id: "x", context: "Revenue was 318.", question: "?", answer: "Revenue was 318.", label: "faithful" };
  it("passes a clean answer and surfaces the fabrication heuristic", () => {
    expect(check(base).ok).toBe(true);
    const bad = check({ ...base, answer: "Revenue was 342." });
    expect(bad.stats.unsupportedNumbers).toBe(1);
  });
  it("fails an empty answer", () => {
    expect(check({ ...base, answer: "" }).ok).toBe(false);
  });
});
