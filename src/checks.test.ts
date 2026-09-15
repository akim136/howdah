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
  it("matches whole number tokens, including decimals, and deduplicates signals", () => {
    expect(unsupportedNumbers("18 18 4 4.1 18%", "318 14 4.12")).toEqual(["18", "4", "4.1", "18%"]);
    expect(unsupportedNumbers("12 400", "12,400")).toEqual(["12", "400"]);
    expect(unsupportedNumbers("12400", "12, 400")).toEqual(["12400"]);
  });
  it("can flag a valid calculation; the heuristic does not decide faithfulness", () => {
    expect(unsupportedNumbers("The total is 5.", "There are 2 red and 3 blue.")).toEqual(["5"]);
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
    expect(bad.numberSignals).toEqual(["342"]);
    expect(bad.ok).toBe(true);
  });
  it("fails an empty answer", () => {
    expect(check({ ...base, answer: "" }).ok).toBe(false);
  });
  it("retains length warnings", () => {
    expect(check({ ...base, answer: "word ".repeat(251) }).failures).toEqual(["answer very long (251 words)"]);
  });
});
