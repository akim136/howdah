import { describe, expect, it } from "vitest";
import { FAITHFULNESS, parseJudge, verdict } from "./rubric.js";
import { parseGrounding } from "./grounding.js";

describe("parseJudge", () => {
  it("computes the weighted overall and keeps flags", () => {
    const raw = JSON.stringify({
      dimensions: [
        { name: "supported_by_context", score: 5, evidence: "all supported" },
        { name: "no_fabrication", score: 5, evidence: "none" },
        { name: "completeness", score: 4, evidence: "ok" },
        { name: "appropriate_refusal", score: 5, evidence: "n/a" },
      ],
      flags: [],
    });
    const p = parseJudge(FAITHFULNESS, raw);
    expect(p.overall).toBeGreaterThanOrEqual(4.0);
    expect(p.flags).toEqual([]);
  });
  it("degrades to a flagged mid verdict on malformed JSON", () => {
    const p = parseJudge(FAITHFULNESS, "not json at all");
    expect(p.flags).toContain("judge response unparseable");
    expect(p.overall).toBe(3);
  });
});

describe("verdict", () => {
  it("marks unfaithful when grounding flags exist even if the score passes", () => {
    const parsed = { dimensions: [], flags: [], overall: 4.6 };
    const v = verdict(FAITHFULNESS, parsed, ["invented number 342"], "sonnet", true);
    expect(v.faithful).toBe(false);
    expect(v.flags.some((f) => f.startsWith("unsupported:"))).toBe(true);
  });
  it("marks faithful when score passes and grounding is clean", () => {
    const parsed = { dimensions: [], flags: [], overall: 4.6 };
    expect(verdict(FAITHFULNESS, parsed, [], "haiku", false).faithful).toBe(true);
  });
});

describe("parseGrounding", () => {
  it("extracts the unsupported list and tolerates junk", () => {
    expect(parseGrounding('{"unsupported":["a","b"]}')).toEqual(["a", "b"]);
    expect(parseGrounding("garbage")).toEqual([]);
  });
});
