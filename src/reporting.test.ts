import { describe, expect, it } from "vitest";
import { check } from "./checks.js";
import { ESCALATE_BUFFER, judge, MODELS } from "./judge.js";
import { buildReport, calculateMetrics, createRun, escapeMarkdown, type RunMetadata } from "./reporting.js";
import { FAITHFULNESS } from "./rubric.js";
import { MAX_TOKENS, REQUEST_POLICY } from "./transport.js";
import { CASE, envelope, groundingResponse, mockFetch, rubricResponse } from "./test-fixtures.js";
import type { Outcome, Row } from "./types.js";

const row = (outcome: Outcome, gold: Row["gold"] = "faithful"): Row => ({ id: outcome, gold, outcome, checks: check(CASE), evaluation: null });
const metadata: RunMetadata = {
  startedAt: "2026-09-14T12:00:00.000Z", completedAt: "2026-09-14T12:00:01.000Z", mode: "full", codeRevision: "abc123", workingTreeDirty: true,
  dataset: { file: "cases.json", sha256: "synthetic-hash" }, rubric: FAITHFULNESS,
  modelConfiguration: { ...MODELS, escalationBuffer: ESCALATE_BUFFER, maxTokens: MAX_TOKENS, requestPolicy: REQUEST_POLICY },
};

describe("classification and coverage", () => {
  it("distinguishes all outcomes and computes confusion counts only for classified cases", () => {
    const result = calculateMetrics([row("unfaithful", "unfaithful"), row("unfaithful"), row("faithful", "unfaithful"), row("faithful"),
      row("abstained"), row("error"), row("skipped")]);
    expect(result).toMatchObject({ total: 7, classified: 4, coverage: 4 / 7, abstained: 1, errors: 1, skipped: 1,
      confusion: { tp: 1, fp: 1, fn: 1, tn: 1 }, precision: 0.5, recall: 0.5, accuracy: 0.5, f1: 0.5 });
  });
  it("reports zero F1 when false positives and false negatives exist but TP is zero", () => {
    expect(calculateMetrics([row("unfaithful"), row("faithful", "unfaithful")])).toMatchObject({ precision: 0, recall: 0, f1: 0 });
  });
  it.each([[], [row("error"), row("error")], [row("abstained")], [row("skipped")]].map((rows) => ({ rows })))("uses null for undefined metrics (%#)", ({ rows }) => {
    expect(calculateMetrics(rows)).toMatchObject({ classified: 0, accuracy: null, precision: null, recall: null, f1: null,
      coverage: rows.length ? 0 : null });
    expect(JSON.stringify(createRun(metadata, rows))).not.toContain("NaN");
  });
  it("handles single-class denominators", () => {
    expect(calculateMetrics([row("faithful")])).toMatchObject({ accuracy: 1, precision: null, recall: null, f1: null });
    expect(calculateMetrics([row("faithful", "unfaithful")])).toMatchObject({ precision: null, recall: 0, f1: 0 });
    expect(calculateMetrics([row("unfaithful")])).toMatchObject({ precision: 0, recall: null, f1: 0 });
  });
});

describe("reports", () => {
  it("escapes pipes, newlines, Markdown links, backslashes, and HTML", () => {
    expect(escapeMarkdown("a|b\r\n<script>[x](url)\\`*")).toBe("a&#124;b<br>&lt;script&gt;&#91;x&#93;(url)&#92;&#96;&#42;");
  });
  it("retains every flag, evidence and superseded stage; measures attempts and tokens", async () => {
    const evaluation = await judge(CASE, { apiKey: "test", rubric: FAITHFULNESS, fetchImpl: mockFetch([
      envelope(rubricResponse(undefined, ["first|flag", "second\nflag"])), envelope(groundingResponse(["superseded finding"])),
      envelope(rubricResponse([5, 5, 1, 1])), envelope(groundingResponse()),
    ]) });
    const run = createRun(metadata, [{ ...row("faithful"), id: "case|<tag>\nnext", evaluation }]);
    expect(run.usage).toMatchObject({ stages: 4, attempts: 4, inputTokens: 492, outputTokens: 180, retries: 0, attemptsWithoutUsage: 0 });
    expect(run.metrics).toMatchObject({ escalated: 1, attempted: 1, escalationRate: 1 });
    const report = buildReport(run);
    for (const finding of ["first&#124;flag", "second<br>flag", "superseded finding", "Evidence for supported&#95;by&#95;context", "case&#124;&lt;tag&gt;<br>next", "Quality / 5", "100.0%", "synthetic-hash", "abc123", "faithfulness-v2"]) {
      expect(report).toContain(finding);
    }
    expect(report).not.toContain("<tag>");
  });
  it("retains all-error and checks-only rows without inventing classification metrics", () => {
    const report = buildReport(createRun(metadata, [row("error"), row("error")]));
    expect(report).toContain("| Classification coverage | 0/2 (0.0%) |");
    expect(report).toContain("| Errors | 2 |");
    expect(report).toContain("| F1 | n/a |");
    const checked = buildReport(createRun({ ...metadata, mode: "checks-only" }, [row("skipped")]));
    expect(checked).toContain("Mode: checks-only");
    expect(checked).toContain("| Skipped | 1 |");
  });
});
