import { describe, expect, it } from "vitest";
import { buildComparisonReport, repeatability, summarizeComparison } from "./comparison.js";
import { outcomeRow, trialRun } from "./comparison-fixtures.js";
import { judge } from "./judge.js";
import { FAITHFULNESS } from "./rubric.js";
import { CASE, envelope, groundingResponse, mockFetch, rubricResponse } from "./test-fixtures.js";
import { parseCompareArgs, trialSchedule } from "./compare.js";

describe("comparison metrics", () => {
  it("reports disagreement, coverage, pooled confusion, and observed trial ranges", () => {
    const trials = [trialRun("haiku", 1, [outcomeRow("faithful"), outcomeRow("unfaithful", "b", "unfaithful")]),
      trialRun("haiku", 2, [outcomeRow("unfaithful"), outcomeRow("error", "b", "unfaithful")]),
      trialRun("haiku", 3, [outcomeRow("faithful"), outcomeRow("unfaithful", "b", "unfaithful")])];
    const result = summarizeComparison(trials, null).strategies[0]!;
    expect(result.pooledMetrics).toMatchObject({ total: 6, classified: 5, errors: 1, coverage: 5 / 6,
      confusion: { tp: 2, fp: 1, fn: 0, tn: 2 } });
    expect(result.repeatability).toEqual({ possiblePairs: 6, eligiblePairs: 4, agreeingPairs: 2, agreement: 0.5, pairCoverage: 4 / 6 });
    expect(result.trialRanges.accuracy).toEqual({ min: 0, max: 1, definedTrials: 3 });
    expect(result.cost.knownUsd).toBeNull();
  });

  it("excludes all errors and skips from repeatability rather than calling them agreement", () => {
    const runs = [1, 2, 3].map((i) => trialRun("haiku", i, [outcomeRow("error"), outcomeRow("skipped", "b")]).run);
    expect(repeatability(runs)).toEqual({ possiblePairs: 6, eligiblePairs: 0, agreeingPairs: 0, agreement: null, pairCoverage: 0 });
    expect(repeatability([runs[0]!]).agreement).toBeNull();
  });

  it("shows stable abstention independently of classification coverage", () => {
    const summary = summarizeComparison([1, 2].map((i) => trialRun("sonnet", i, [outcomeRow("abstained")])), null);
    expect(summary.strategies[0]).toMatchObject({ pooledMetrics: { coverage: 0, accuracy: null }, repeatability: { agreement: 1, pairCoverage: 1 } });
    expect(buildComparisonReport(summary)).toContain("Stable abstention");
  });

  it("retains usage and case latency from failed and successful attempts", async () => {
    const evaluation = await judge(CASE, { apiKey: "test", rubric: FAITHFULNESS, strategy: "haiku",
      fetchImpl: mockFetch([envelope(rubricResponse()), envelope(groundingResponse())]) });
    evaluation.stages[0]!.latencyMs = 80;
    evaluation.stages[1]!.latencyMs = 20;
    const summary = summarizeComparison([trialRun("haiku", 1, [{ ...outcomeRow("faithful"), evaluation }])], null);
    expect(summary.strategies[0]).toMatchObject({ usage: { inputTokens: 246, outputTokens: 90, attempts: 2 },
      latency: { measuredCases: 1, totalMs: 100, p50Ms: 100, p95Ms: 100 } });
  });

  it("rejects mismatched inputs/configuration, duplicate trials and incomplete strategy groups", () => {
    const a = trialRun("haiku", 1);
    const wrongData = trialRun("sonnet", 1);
    wrongData.run.metadata.dataset.sha256 = "different";
    const wrongRubric = trialRun("sonnet", 1);
    wrongRubric.run.metadata.rubric = { ...FAITHFULNESS, threshold: 4.5 };
    const wrongMode = trialRun("sonnet", 1);
    wrongMode.run.metadata.mode = "checks-only";
    for (const trials of [[], [a, a], [a, wrongData], [a, wrongRubric], [a, wrongMode],
      [a, trialRun("sonnet", 1, [outcomeRow("faithful", "different")])],
      [a, trialRun("haiku", 2), trialRun("sonnet", 1)], [trialRun("haiku", 2)]]) {
      expect(() => summarizeComparison(trials, null)).toThrow();
    }
  });

  it("escapes dataset text and renders every strategy with undefined metrics honestly", () => {
    const a = trialRun("haiku", 1, [outcomeRow("error")]);
    const b = trialRun("sonnet", 1, [outcomeRow("error")]);
    a.run.metadata.dataset.file = b.run.metadata.dataset.file = "<script>|data";
    const report = buildComparisonReport(summarizeComparison([a, b], null));
    expect(report).toContain("&lt;script&gt;&#124;data");
    expect(report).not.toContain("<script>");
    expect(report).toContain("| haiku | n/a | n/a | n/a | n/a | 0.0% |");
    expect(report).toContain("| sonnet | n/a | n/a | n/a | n/a | 0.0% |");
    expect(report).toContain("not confidence intervals");
  });
});

describe("comparison scheduling and options", () => {
  it("rotates strategy order and gives every strategy each trial exactly once", () => {
    expect(trialSchedule(["haiku", "sonnet", "cascade"], 3)).toEqual([
      { strategy: "haiku", trial: 1 }, { strategy: "sonnet", trial: 1 }, { strategy: "cascade", trial: 1 },
      { strategy: "sonnet", trial: 2 }, { strategy: "cascade", trial: 2 }, { strategy: "haiku", trial: 2 },
      { strategy: "cascade", trial: 3 }, { strategy: "haiku", trial: 3 }, { strategy: "sonnet", trial: 3 },
    ]);
  });
  it.each(["0", "21", "-1", "1.5", "1e1", "NaN", "Infinity", "9007199254740992"])("rejects invalid trial count %s", (n) => {
    expect(() => parseCompareArgs(["--trials", n])).toThrow();
  });
  it.each(["haiku,haiku", "", "unknown", "haiku, sonnet", "haiku,"])("rejects invalid strategy list %s", (list) => {
    expect(() => parseCompareArgs(["--strategies", list])).toThrow();
  });
  it("accepts bounded counts and explicit strategy subsets", () => {
    expect(parseCompareArgs(["--trials", "20", "--strategies", "sonnet,haiku", "--checks-only"]))
      .toMatchObject({ trials: 20, strategies: ["sonnet", "haiku"], checksOnly: true });
    expect(parseCompareArgs([])).toMatchObject({ trials: 3, strategies: ["haiku", "sonnet", "cascade"], pricing: null });
    expect(() => parseCompareArgs(["--pricing"])).toThrow();
    expect(() => parseCompareArgs(["--unknown"])).toThrow();
  });
});
