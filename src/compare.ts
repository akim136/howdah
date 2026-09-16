import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComparisonArtifacts } from "./artifacts.js";
import { buildComparisonReport, summarizeComparison, type TrialRun } from "./comparison.js";
import { ESCALATE_BUFFER, MODELS, STRATEGIES } from "./judge.js";
import { readPricing } from "./pricing.js";
import { createRun } from "./reporting.js";
import { FAITHFULNESS } from "./rubric.js";
import { evaluateCases, getApiKey, readDataset, revision, ROOT } from "./runtime.js";
import { MAX_TOKENS, REQUEST_POLICY } from "./transport.js";
import type { Strategy } from "./types.js";

export function parseCompareArgs(argv: string[]) {
  const options = { dataset: join(ROOT, "data/cases.json"), outputDir: join(ROOT, "comparisons"),
    trials: 3, strategies: [...STRATEGIES], checksOnly: false, quiet: false, pricing: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--checks-only") { options.checksOnly = true; continue; }
    if (arg === "--quiet") { options.quiet = true; continue; }
    if (!["--dataset", "--output-dir", "--trials", "--strategies", "--pricing"].includes(arg!)) throw new Error("Unknown comparison argument.");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("Comparison option requires a value.");
    if (arg === "--trials") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20) throw new Error("--trials must be an integer from 1 to 20.");
      options.trials = Number(value);
    } else if (arg === "--strategies") {
      const strategies = value.split(",");
      if (strategies.some((s) => !STRATEGIES.includes(s as Strategy)) || new Set(strategies).size !== strategies.length)
        throw new Error("--strategies must list unique values from haiku,sonnet,cascade.");
      options.strategies = strategies as Strategy[];
    } else options[arg === "--dataset" ? "dataset" : arg === "--pricing" ? "pricing" : "outputDir"] = resolve(value);
  }
  return options;
}

/** Rotate strategy order between trials to avoid always testing one model first. */
export function trialSchedule(strategies: Strategy[], trials: number) {
  return Array.from({ length: trials }, (_, i) => strategies.map((_, j) => ({ strategy: strategies[(j + i) % strategies.length]!, trial: i + 1 }))).flat();
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseCompareArgs(argv);
  const dataset = readDataset(options.dataset); // Read and validate once; all strategies get identical inputs.
  const pricing = options.pricing ? readPricing(options.pricing) : null;
  const apiKey = getApiKey(options.checksOnly);
  const code = revision();
  const schedule = trialSchedule(options.strategies, options.trials);
  let artifacts: ComparisonArtifacts;
  try { artifacts = new ComparisonArtifacts(options.outputDir, schedule.length); }
  catch { throw new Error("Cannot create comparison output directory."); }
  const runs: TrialRun[] = [];
  const maxAttempts = options.checksOnly ? 0 : dataset.cases.length * options.trials
    * options.strategies.reduce((sum, s) => sum + (s === "cascade" ? 4 : 2), 0) * (REQUEST_POLICY.maxRetries + 1);
  if (!options.quiet) console.error(`Planned runs: ${schedule.length}; cases per run: ${dataset.cases.length}; maximum API attempts including retries: ${maxAttempts}.`);
  try {
    for (const { strategy, trial } of schedule) {
      const startedAt = new Date().toISOString();
      const rows = await evaluateCases(dataset.cases, { checksOnly: options.checksOnly, apiKey, strategy,
        onProgress: (row, index) => { if (!options.quiet) console.error(`${strategy} trial ${trial}, case ${index}/${dataset.cases.length}: ${row.outcome}`); },
      });
      const run = createRun({ ...code, strategy, trial, startedAt, completedAt: new Date().toISOString(),
        mode: options.checksOnly ? "checks-only" : "full", dataset: dataset.metadata, rubric: FAITHFULNESS,
        modelConfiguration: { ...MODELS, escalationBuffer: ESCALATE_BUFFER, maxTokens: MAX_TOKENS, requestPolicy: REQUEST_POLICY },
      }, rows);
      const entry = { strategy, trial, run };
      artifacts.writeTrial(entry);
      runs.push(entry);
    }
    const summary = summarizeComparison(runs, pricing);
    const directory = artifacts.finish(summary);
    const errors = summary.strategies.reduce((sum, s) => sum + s.pooledMetrics.errors, 0);
    if (!options.quiet) console.log(buildComparisonReport(summary));
    console.error(`Wrote comparison bundle: ${directory}. Evaluation errors: ${errors}.`);
    return errors ? 1 : 0;
  } catch {
    try { artifacts.fail(); } catch { /* Completed trial files remain available even if the manifest cannot be updated. */ }
    throw new Error(`Comparison did not finish. Partial artifacts remain in ${artifacts.staging}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Comparison failed.");
    process.exitCode = 1;
  });
}
