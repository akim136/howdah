import type { Rubric } from "./rubric.js";
import type { Row, Strategy } from "./types.js";

const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;

/** Classification metrics are conditional on classified cases; coverage always uses all cases. */
export function calculateMetrics(rows: Row[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const classified = rows.filter((r) => r.outcome === "faithful" || r.outcome === "unfaithful");
  for (const row of classified) {
    if (row.outcome === "unfaithful") { if (row.gold === "unfaithful") tp++; else fp++; }
    else { if (row.gold === "unfaithful") fn++; else tn++; }
  }
  const abstained = rows.filter((r) => r.outcome === "abstained").length;
  const errors = rows.filter((r) => r.outcome === "error").length;
  const skipped = rows.filter((r) => r.outcome === "skipped").length;
  const escalated = rows.filter((r) => r.evaluation?.escalated).length;
  const attempted = rows.filter((r) => (r.evaluation?.stages.length ?? 0) > 0).length;
  return {
    total: rows.length, classified: classified.length, abstained, errors, skipped, attempted, escalated,
    coverage: ratio(classified.length, rows.length), escalationRate: ratio(escalated, attempted),
    confusion: { tp, fp, fn, tn }, accuracy: ratio(tp + tn, classified.length),
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
  };
}

export interface RunMetadata {
  strategy?: Strategy;
  trial?: number;
  startedAt: string;
  completedAt: string;
  mode: "full" | "checks-only";
  codeRevision: string | null;
  workingTreeDirty: boolean | null;
  dataset: { file: string; sha256: string };
  rubric: Rubric;
  modelConfiguration: {
    screen: string; escalation: string; escalationBuffer: number; maxTokens: number;
    requestPolicy: { timeoutMs: number; maxRetries: number; backoffMs: readonly number[]; maxBackoffMs: number };
  };
}

export function createRun(metadata: RunMetadata, rows: Row[]) {
  const stages = rows.flatMap((r) => r.evaluation?.stages ?? []);
  const attempts = stages.flatMap((s) => s.attempts);
  const measured = attempts.flatMap((a) => a.usage ? [a.usage] : []);
  return {
    schemaVersion: "2.0", metadata, metrics: calculateMetrics(rows),
    usage: {
      stages: stages.length, attempts: attempts.length, retries: stages.reduce((n, s) => n + s.retryCount, 0),
      stageLatencyMs: stages.reduce((n, s) => n + s.latencyMs, 0),
      attemptsWithoutUsage: attempts.length - measured.length,
      inputTokens: measured.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: measured.reduce((n, u) => n + u.outputTokens, 0),
      cacheCreationInputTokens: measured.reduce((n, u) => n + u.cacheCreationInputTokens, 0),
      cacheReadInputTokens: measured.reduce((n, u) => n + u.cacheReadInputTokens, 0),
    },
    rows,
  };
}

export type RunResult = ReturnType<typeof createRun>;

/** Escape untrusted strings before placing them in Markdown, including table separators and HTML. */
export function escapeMarkdown(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\|`*_[\]{}!]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/\r\n|\r|\n/g, "<br>").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

const pct = (n: number | null) => n === null ? "n/a" : `${(100 * n).toFixed(1)}%`;
const score = (n: number | null | undefined) => n == null ? "—" : n.toFixed(2);
const tableRow = (cells: unknown[]) => `| ${cells.map(escapeMarkdown).join(" | ")} |`;

export function buildReport(run: RunResult): string {
  const { metadata: meta, metrics: m, usage: u, rows } = run;
  const md = [
    `# Faithfulness evaluation — ${escapeMarkdown(meta.completedAt.slice(0, 10))}`, "",
    `Format: ${run.schemaVersion}. Mode: ${meta.mode}. Cases: ${m.total}.`, "",
    `Strategy: ${meta.strategy ?? "cascade"}${meta.trial === undefined ? "" : `; trial: ${meta.trial}`}.`, "",
    `Code revision: ${escapeMarkdown(meta.codeRevision ?? "unavailable")}; working tree dirty: ${meta.workingTreeDirty ?? "unknown"}.`,
    `Dataset: ${escapeMarkdown(meta.dataset.file)}; SHA-256: ${meta.dataset.sha256}.`,
    `Rubric: ${escapeMarkdown(meta.rubric.version)}; faithfulness threshold: ${meta.rubric.threshold}.`,
    `Started: ${meta.startedAt}. Completed: ${meta.completedAt}.`, "",
    "## Coverage and classification", "",
    "Coverage is classified cases / all cases. Accuracy, precision, recall, and F1 use classified cases only; unfaithful is the positive class.", "",
    "| Metric | Value |", "|---|---|",
    tableRow(["Classification coverage", `${m.classified}/${m.total} (${pct(m.coverage)})`]),
    tableRow(["Abstained", m.abstained]), tableRow(["Errors", m.errors]), tableRow(["Skipped", m.skipped]),
    tableRow(["Accuracy", pct(m.accuracy)]), tableRow(["Precision", pct(m.precision)]),
    tableRow(["Recall", pct(m.recall)]), tableRow(["F1", pct(m.f1)]),
    tableRow(["Escalations / cases with API attempts", `${m.escalated}/${m.attempted} (${pct(m.escalationRate)})`]), "",
    `Confusion counts: TP ${m.confusion.tp} · FP ${m.confusion.fp} · FN ${m.confusion.fn} · TN ${m.confusion.tn}.`, "",
    "Abstentions, errors, and skipped rows remain in this report but are excluded from classification metrics. Poor classification performance does not cause an infrastructure failure.", "",
    "## Configuration and measurement", "",
    `Models: ${escapeMarkdown(meta.strategy === "haiku" ? meta.modelConfiguration.screen : meta.strategy === "sonnet" ? meta.modelConfiguration.escalation : `${meta.modelConfiguration.screen} → ${meta.modelConfiguration.escalation}`)}. Escalation buffer (cascade only): ${meta.modelConfiguration.escalationBuffer}. Max output tokens per call: ${meta.modelConfiguration.maxTokens}.`,
    `Request timeout: ${meta.modelConfiguration.requestPolicy.timeoutMs} ms; at most ${meta.modelConfiguration.requestPolicy.maxRetries} retries; backoff: ${meta.modelConfiguration.requestPolicy.backoffMs.join(", ")} ms (Retry-After capped at ${meta.modelConfiguration.requestPolicy.maxBackoffMs} ms).`, "",
    "| Dimension | Category | Weight within category |", "|---|---|---|",
    ...meta.rubric.dimensions.map((d) => tableRow([d.name, d.category, d.weight.toFixed(6)])), "",
    `Recorded stages: ${u.stages}; API attempts: ${u.attempts}; retries: ${u.retries}; summed stage latency including backoff: ${u.stageLatencyMs} ms.`,
    `Recorded input/output tokens: ${u.inputTokens}/${u.outputTokens}; cache creation/read input tokens: ${u.cacheCreationInputTokens}/${u.cacheReadInputTokens}. Attempts without usage: ${u.attemptsWithoutUsage} (unknown, not zero cost).`, "",
    "## Advisory checks", "",
    `Numbers absent from context were flagged in ${rows.filter((r) => r.checks.numberSignals.length > 0).length} case(s). Number, length, and refusal signals are for review; arithmetic can introduce supported numbers, and matching numbers can still be misused. These checks do not decide faithfulness. Empty answers abstain in full mode.`, "",
    "## Every case", "",
    "| Case | Gold | Outcome | Faithfulness / 5 | Quality / 5 | Escalated | All final findings |", "|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const e = row.evaluation;
    const findings = [...row.checks.failures, ...row.checks.numberSignals.map((n) => `number absent from context: ${n}`),
      ...(e?.flags ?? []), ...(e?.reason ? [e.reason] : [])];
    md.push(tableRow([row.id, row.gold, row.outcome, score(e?.faithfulnessScore), score(e?.answerQualityScore), e?.escalated ? "yes" : "no", findings.join("; ")]));
  }
  md.push("", "## Stage evidence and diagnostics", "", "All validated stage findings are retained, including superseded screen results. Quality scores never enter the faithfulness threshold.", "");
  for (const row of rows) {
    md.push(`### ${escapeMarkdown(row.id)}`, "",
      `Advisory checks: ${row.checks.stats.words} words; refusal signal: ${row.checks.stats.refused === 1 ? "yes" : "no"}; number signals: ${row.checks.numberSignals.length}.`, "");
    if (!row.evaluation?.stages.length) md.push(`No API stages. ${escapeMarkdown(row.evaluation?.reason ?? "checks-only mode")}.`, "");
    for (const [index, stage] of (row.evaluation?.stages ?? []).entries()) {
      md.push(`Stage ${index + 1}: ${stage.kind}, ${escapeMarkdown(stage.model)}; ${stage.latencyMs} ms; retries ${stage.retryCount}; ${stage.errorCode ?? stage.result?.status}.`, "");
      if (stage.result?.status === "abstained") md.push(`Abstention: ${escapeMarkdown(stage.result.reason)}`, "");
      if (stage.kind === "rubric" && stage.result?.status === "evaluated") {
        md.push(`Faithfulness: ${score(stage.result.faithfulnessScore)}; quality: ${score(stage.result.answerQualityScore)}.`, "",
          "| Dimension | Score / 5 | Evidence |", "|---|---|---|",
          ...stage.result.dimensions.map((d) => tableRow([d.name, d.score, d.evidence])), "",
          `Faithfulness flags: ${stage.result.flags.length ? stage.result.flags.map(escapeMarkdown).join("; ") : "none"}.`, "");
      }
      if (stage.kind === "grounding" && stage.result?.status === "evaluated") {
        md.push(`Unsupported claims: ${stage.result.unsupported.length ? stage.result.unsupported.map(escapeMarkdown).join("; ") : "none"}.`, "");
      }
      md.push("| Attempt | HTTP | Response model | Stop | Input / output tokens | Cache creation / read | Latency ms | Error code |", "|---|---|---|---|---|---|---|---|");
      stage.attempts.forEach((a, i) => md.push(tableRow([i + 1, a.httpStatus ?? "—", a.responseModel ?? "—", a.stopReason ?? "—",
        a.usage ? `${a.usage.inputTokens} / ${a.usage.outputTokens}` : "unknown", a.usage ? `${a.usage.cacheCreationInputTokens} / ${a.usage.cacheReadInputTokens}` : "unknown",
        a.latencyMs, a.errorCode ?? "—"])));
      md.push("");
    }
  }
  return `${md.join("\n")}\n`;
}
