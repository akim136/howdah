/**
 * Run the harness over data/cases.json and write report.md.
 *
 *   npm run eval                  full run (deterministic checks + LLM judge + grounding) — needs ANTHROPIC_API_KEY
 *   npm run eval -- --checks-only deterministic layer only — no API key, free
 *   npm run eval -- --quiet       don't print the report to stdout
 *
 * Treats "unfaithful" as the positive class (we are detecting hallucinations) and scores the judge's
 * predictions against the gold labels: precision / recall / F1, plus the Haiku→Sonnet escalation rate.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./checks.js";
import { judge } from "./judge.js";
import { FAITHFULNESS } from "./rubric.js";
import type { Case } from "./types.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Minimal .env loader (KEY=VALUE lines) so `cp .env.example .env` just works. */
function loadEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

interface Row {
  id: string;
  gold: "faithful" | "unfaithful";
  predicted: "faithful" | "unfaithful" | "—";
  score: number | null;
  escalated: boolean;
  refused: boolean;
  unsupportedNumbers: number;
  flags: string[];
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const checksOnly = argv.includes("--checks-only");
  const quiet = argv.includes("--quiet");
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const cases = JSON.parse(readFileSync(join(ROOT, "data", "cases.json"), "utf8")) as Case[];
  const judging = !checksOnly && !!apiKey;
  if (!checksOnly && !apiKey) console.error("ANTHROPIC_API_KEY not set — running deterministic checks only.\n");

  const rows: Row[] = [];
  for (const c of cases) {
    const chk = check(c);
    const row: Row = {
      id: c.id,
      gold: c.label,
      predicted: "—",
      score: null,
      escalated: false,
      refused: chk.stats.refused === 1,
      unsupportedNumbers: Number(chk.stats.unsupportedNumbers ?? 0),
      flags: [...chk.failures],
    };
    if (judging) {
      // Isolate per-case failures: one API hiccup shouldn't abandon the whole run. The case stays
      // predicted "—" and is excluded from the metrics below.
      try {
        const v = await judge(c, { apiKey: apiKey!, rubric: FAITHFULNESS });
        row.predicted = v.faithful ? "faithful" : "unfaithful";
        row.score = v.overall;
        row.escalated = v.escalated;
        row.flags.push(...v.flags);
      } catch (err) {
        row.flags.push(`judge error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    rows.push(row);
    if (!quiet) process.stderr.write(`  ${row.id}: gold=${row.gold} predicted=${row.predicted}${row.score !== null ? ` (${row.score}/5${row.escalated ? " [sonnet]" : ""})` : ""}\n`);
  }

  const md = buildReport(rows, judging);
  writeFileSync(join(ROOT, "report.md"), md);
  if (!quiet) console.log(`\n${md}`);
  console.error(`\n✓ wrote report.md`);
}

function buildReport(rows: Row[], judging: boolean): string {
  const n = rows.length;
  const stamp = new Date().toISOString().slice(0, 10);
  const md: string[] = [`# Faithfulness eval report — ${stamp}`, "", `Cases: ${n}. Mode: ${judging ? "deterministic checks + LLM judge + grounding" : "deterministic checks only (no API key)"}.`, ""];

  // Deterministic layer: the free number-fabrication heuristic.
  const numHeuristicHits = rows.filter((r) => r.unsupportedNumbers > 0);
  const numHeuristicOnUnfaithful = numHeuristicHits.filter((r) => r.gold === "unfaithful").length;
  md.push(`## Deterministic layer (free, no API key)`);
  md.push(`The unsupported-number heuristic flagged ${numHeuristicHits.length} case(s); ${numHeuristicOnUnfaithful} of those are gold-unfaithful (cheap fabrication catches before any LLM call).`, "");

  if (judging) {
    // Hallucination detection treated as positive class = "unfaithful". Only count cases the judge
    // actually scored (a per-case error leaves predicted "—" and is excluded here).
    const judged = rows.filter((r) => r.predicted !== "—");
    const errored = rows.length - judged.length;
    let tp = 0, fp = 0, fn = 0, tn = 0, escalated = 0;
    for (const r of judged) {
      const predUnfaithful = r.predicted === "unfaithful";
      const goldUnfaithful = r.gold === "unfaithful";
      if (predUnfaithful && goldUnfaithful) tp++;
      else if (predUnfaithful && !goldUnfaithful) fp++;
      else if (!predUnfaithful && goldUnfaithful) fn++;
      else tn++;
      if (r.escalated) escalated++;
    }
    const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "n/a");
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const f1 = (2 * precision * recall) / (precision + recall);
    const accuracy = judged.length ? (tp + tn) / judged.length : NaN;
    md.push(`## Hallucination detection (positive class = "unfaithful")`, "");
    if (errored) md.push(`> ${errored} case(s) errored during judging and are excluded from the metrics below.`, "");
    md.push(`| Metric | Value |`, `|---|---|`);
    md.push(`| Accuracy | ${pct(accuracy)} |`);
    md.push(`| Precision | ${pct(precision)} |`);
    md.push(`| Recall | ${pct(recall)} |`);
    md.push(`| F1 | ${pct(f1)} |`);
    md.push(`| Judge escalations (Haiku→Sonnet) | ${escalated}/${judged.length} |`, "");
    md.push(`Confusion matrix: TP ${tp} · FP ${fp} · FN ${fn} · TN ${tn}`, "");
  }

  md.push(`## Per-case`, "");
  md.push(`| Case | Gold | Predicted | Score | Esc | Flag |`, `|---|---|---|---|---|---|`);
  for (const r of rows) {
    const correct = r.predicted === "—" ? "" : r.predicted === r.gold ? "" : " ❌";
    md.push(`| ${r.id} | ${r.gold} | ${r.predicted}${correct} | ${r.score ?? "—"} | ${r.escalated ? "✓" : ""} | ${(r.flags[0] ?? "").slice(0, 60)} |`);
  }
  md.push("", `_Generated by faithfulness-eval-harness. Gold labels are in \`data/cases.json\`._`);
  return md.join("\n");
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
