import { estimateCost, type Pricing } from "./pricing.js";
import { calculateMetrics, escapeMarkdown, type RunResult } from "./reporting.js";
import type { Outcome, Row, Strategy } from "./types.js";

export interface TrialRun { strategy: Strategy; trial: number; run: RunResult }

const ratio = (n: number, d: number) => d ? n / d : null;
const eligible = (outcome: Outcome) => outcome === "faithful" || outcome === "unfaithful" || outcome === "abstained";

/** Pairwise agreement on the same case. Errors/skips never count as successful agreement. */
export function repeatability(runs: RunResult[]) {
  const cases = new Map<string, Outcome[]>();
  for (const run of runs) for (const row of run.rows) cases.set(row.id, [...(cases.get(row.id) ?? []), row.outcome]);
  let possiblePairs = 0, eligiblePairs = 0, agreeingPairs = 0;
  for (const outcomes of cases.values()) for (let i = 0; i < outcomes.length; i++) for (let j = i + 1; j < outcomes.length; j++) {
    possiblePairs++;
    if (eligible(outcomes[i]!) && eligible(outcomes[j]!)) {
      eligiblePairs++;
      if (outcomes[i] === outcomes[j]) agreeingPairs++;
    }
  }
  return { possiblePairs, eligiblePairs, agreeingPairs, agreement: ratio(agreeingPairs, eligiblePairs), pairCoverage: ratio(eligiblePairs, possiblePairs) };
}

function range(values: (number | null)[]) {
  const defined = values.filter((v): v is number => v !== null);
  return { min: defined.length ? Math.min(...defined) : null, max: defined.length ? Math.max(...defined) : null, definedTrials: defined.length };
}

function latency(rows: Row[]) {
  const samples = rows.filter((r) => (r.evaluation?.stages.length ?? 0) > 0)
    .map((r) => r.evaluation!.stages.reduce((sum, stage) => sum + stage.latencyMs, 0)).sort((a, b) => a - b);
  const quantile = (p: number) => samples.length ? samples[Math.max(0, Math.ceil(samples.length * p) - 1)]! : null;
  return { measuredCases: samples.length, totalMs: samples.reduce((sum, n) => sum + n, 0), p50Ms: quantile(0.5), p95Ms: quantile(0.95) };
}

/** Validate comparison alignment so accidentally mixed datasets/trials cannot produce a leaderboard. */
export function summarizeComparison(trials: TrialRun[], pricing: Pricing | null) {
  const first = trials[0];
  if (!first) throw new Error("Comparison requires at least one trial.");
  const identity = (run: RunResult) => JSON.stringify({ dataset: run.metadata.dataset.sha256, rubric: run.metadata.rubric,
    mode: run.metadata.mode, models: run.metadata.modelConfiguration, code: run.metadata.codeRevision,
    dirty: run.metadata.workingTreeDirty, rows: run.rows.map((r) => [r.id, r.gold]) });
  const expected = identity(first.run);
  const seen = new Set<string>();
  const strategies = [...new Set(trials.map((r) => r.strategy))];
  for (const trial of trials) {
    if (!Number.isSafeInteger(trial.trial) || trial.trial < 1 || seen.has(`${trial.strategy}:${trial.trial}`)
      || identity(trial.run) !== expected || trial.run.metadata.strategy !== trial.strategy || trial.run.metadata.trial !== trial.trial)
      throw new Error("Comparison trials must have matching inputs/configuration and unique strategy/trial identities.");
    seen.add(`${trial.strategy}:${trial.trial}`);
  }
  const trialNumbers = (strategy: Strategy) => trials.filter((r) => r.strategy === strategy).map((r) => r.trial).sort((a, b) => a - b);
  const expectedNumbers = trialNumbers(first.strategy);
  if (expectedNumbers.some((n, i) => n !== i + 1) || strategies.some((s) => JSON.stringify(trialNumbers(s)) !== JSON.stringify(expectedNumbers)))
    throw new Error("Every strategy must contain the same complete set of consecutive trials.");
  return {
    schemaVersion: "comparison-v1",
    metadata: { dataset: first.run.metadata.dataset, mode: first.run.metadata.mode, codeRevision: first.run.metadata.codeRevision,
      workingTreeDirty: first.run.metadata.workingTreeDirty, rubric: first.run.metadata.rubric, modelConfiguration: first.run.metadata.modelConfiguration,
      cases: first.run.rows.length, trialsPerStrategy: expectedNumbers.length, strategies, pricing,
      startedAt: trials.map((r) => r.run.metadata.startedAt).sort()[0]!, completedAt: trials.map((r) => r.run.metadata.completedAt).sort().at(-1)!,
      executionOrder: trials.map(({ strategy, trial }) => ({ strategy, trial })) },
    strategies: strategies.map((strategy) => {
      const selected = trials.filter((r) => r.strategy === strategy);
      const runs = selected.map((r) => r.run);
      const rows = runs.flatMap((run) => run.rows);
      const metrics = runs.map((run) => calculateMetrics(run.rows));
      const usage = { stages: 0, attempts: 0, retries: 0, stageLatencyMs: 0, attemptsWithoutUsage: 0,
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      for (const run of runs) for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] += run.usage[key];
      return { strategy, pooledMetrics: calculateMetrics(rows),
        trialMetrics: selected.map((r, i) => ({ trial: r.trial, metrics: metrics[i]! })),
        trialRanges: { accuracy: range(metrics.map((m) => m.accuracy)), precision: range(metrics.map((m) => m.precision)),
          recall: range(metrics.map((m) => m.recall)), f1: range(metrics.map((m) => m.f1)), coverage: range(metrics.map((m) => m.coverage)) },
        repeatability: repeatability(runs), usage, latency: latency(rows), cost: estimateCost(rows, pricing) };
    }),
  };
}

export type ComparisonSummary = ReturnType<typeof summarizeComparison>;
const pct = (n: number | null) => n === null ? "n/a" : `${(100 * n).toFixed(1)}%`;
const table = (cells: unknown[]) => `| ${cells.map(escapeMarkdown).join(" | ")} |`;

export function buildComparisonReport(summary: ComparisonSummary): string {
  const { metadata: m } = summary;
  const md = ["# Model comparison", "", `Format: ${summary.schemaVersion}. Mode: ${m.mode}. Cases: ${m.cases}; trials per strategy: ${m.trialsPerStrategy}.`, "",
    `Dataset: ${escapeMarkdown(m.dataset.file)}; SHA-256: ${m.dataset.sha256}.`,
    `Code: ${escapeMarkdown(m.codeRevision ?? "unavailable")}; working tree dirty: ${m.workingTreeDirty ?? "unknown"}. Rubric: ${escapeMarkdown(m.rubric.version)}.`, "",
    "Classification metrics are pooled across repeated case evaluations and are conditional on classification. Repeats are not independent samples. Trial ranges below describe observed variability, not confidence intervals.", "",
    "| Strategy | Accuracy | Precision | Recall | F1 | Coverage | Abstained | Errors | Skipped |", "|---|---|---|---|---|---|---|---|---|"];
  for (const s of summary.strategies) {
    const p = s.pooledMetrics;
    md.push(table([s.strategy, pct(p.accuracy), pct(p.precision), pct(p.recall), pct(p.f1), pct(p.coverage), p.abstained, p.errors, p.skipped]));
  }
  md.push("", "## Repeatability and measurements", "",
    "Agreement counts pairs of valid outcomes (faithful, unfaithful, or abstained) for the same case across trials. Errors/skipped rows are excluded from eligible pairs and reduce pair coverage. Stable abstention can yield agreement without classification; read both coverages.", "",
    "| Strategy | Agreement | Eligible / possible pairs | API attempts / retries | Input / output tokens | Case API latency p50 / p95 ms | Known estimated USD | Cost complete |", "|---|---|---|---|---|---|---|---|");
  for (const s of summary.strategies) md.push(table([s.strategy, pct(s.repeatability.agreement), `${s.repeatability.eligiblePairs} / ${s.repeatability.possiblePairs}`,
    `${s.usage.attempts} / ${s.usage.retries}`, `${s.usage.inputTokens} / ${s.usage.outputTokens}`, `${s.latency.p50Ms ?? "n/a"} / ${s.latency.p95Ms ?? "n/a"}`,
    s.cost.knownUsd === null ? "n/a" : s.cost.knownUsd.toFixed(6), s.cost.complete ? "yes" : "no"]));
  md.push("", "Latency sums serial stage time, including backoff, for cases with API attempts. Percentiles use the nearest rank. Token and cost totals include recorded usage on unsuccessful attempts. Unknown usage is never assumed free.", "",
    m.pricing ? `Pricing: ${escapeMarkdown(m.pricing.source)}; as of ${escapeMarkdown(m.pricing.asOf)}. Rates are recorded in comparison.json; these are estimates, not billing totals.` : "No pricing supplied; cost is not estimated.", "");
  for (const s of summary.strategies) {
    md.push(`## ${s.strategy}`, "", `Unknown-usage attempts: ${s.cost.missingUsageAttempts}; attempts with missing rates: ${s.cost.unpricedAttempts}.`,
      `Confusion counts over repeated evaluations: TP ${s.pooledMetrics.confusion.tp}; FP ${s.pooledMetrics.confusion.fp}; FN ${s.pooledMetrics.confusion.fn}; TN ${s.pooledMetrics.confusion.tn}.`, "",
      "| Metric | Trial minimum | Trial maximum | Defined trials |", "|---|---|---|---|");
    for (const [name, values] of Object.entries(s.trialRanges)) md.push(table([name, pct(values.min), pct(values.max), values.definedTrials]));
    md.push("", "| Trial | Accuracy | Precision | Recall | F1 | Coverage | Errors |", "|---|---|---|---|---|---|---|");
    for (const { trial, metrics } of s.trialMetrics) md.push(table([trial, pct(metrics.accuracy), pct(metrics.precision), pct(metrics.recall), pct(metrics.f1), pct(metrics.coverage), metrics.errors]));
    md.push("");
  }
  md.push("Each trial directory retains every case and every attempted stage. Consult manifest.json for artifact paths and hashes; inspect disagreements and errors before selecting a strategy.", "");
  return md.join("\n");
}
