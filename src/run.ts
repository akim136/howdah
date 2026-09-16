import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESCALATE_BUFFER, MODELS, STRATEGIES } from "./judge.js";
import { buildReport, createRun } from "./reporting.js";
import { FAITHFULNESS } from "./rubric.js";
import { evaluateCases, getApiKey, readDataset, revision, ROOT } from "./runtime.js";
import { MAX_TOKENS, REQUEST_POLICY } from "./transport.js";
import type { Strategy } from "./types.js";

export function parseArgs(argv: string[]) {
  const options = { checksOnly: false, quiet: false, dataset: join(ROOT, "data/cases.json"), outputDir: ROOT, strategy: "cascade" as Strategy };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--checks-only") options.checksOnly = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--strategy") {
      const value = argv[++i];
      if (!STRATEGIES.includes(value as Strategy)) throw new Error("--strategy must be haiku, sonnet, or cascade.");
      options.strategy = value as Strategy;
    }
    else if (arg === "--dataset" || arg === "--output-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path.`);
      options[arg === "--dataset" ? "dataset" : "outputDir"] = resolve(value);
    } else throw new Error("Unknown argument. Supported: --dataset PATH --output-dir PATH --strategy haiku|sonnet|cascade --checks-only --quiet.");
  }
  if (["results.json", "report.md"].some((name) => resolve(options.dataset) === join(options.outputDir, name)))
    throw new Error("Dataset path must differ from output artifact paths.");
  return options;
}

/** Replace a report only after its complete contents have been written. */
function writeArtifact(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const dataset = readDataset(options.dataset);
  const cases = dataset.cases;
  const apiKey = getApiKey(options.checksOnly);
  // Detect an unusable output directory before incurring API costs.
  let datasetPath: string;
  let outputDirectory: string;
  try {
    mkdirSync(options.outputDir, { recursive: true });
    datasetPath = realpathSync(options.dataset);
    outputDirectory = realpathSync(options.outputDir);
    for (const name of ["results.json", "report.md"]) {
      if (existsSync(join(options.outputDir, name)) && !statSync(join(options.outputDir, name)).isFile()) throw new Error();
    }
    const probe = join(options.outputDir, `.howdah-${randomUUID()}.tmp`);
    try { writeFileSync(probe, "", { flag: "wx" }); }
    finally { rmSync(probe, { force: true }); }
  } catch { throw new Error("Cannot use output directory."); }
  // Directory aliases can bypass the lexical check in parseArgs and overwrite the input.
  if (["results.json", "report.md"].some((name) => join(outputDirectory, name) === datasetPath))
    throw new Error("Dataset path must differ from output artifact paths.");
  const code = revision();
  const rows = await evaluateCases(cases, { ...options, apiKey,
    onProgress: (row, index) => { if (!options.quiet) process.stderr.write(`Case ${index}/${cases.length}: ${row.outcome}\n`); },
  });
  const run = createRun({ startedAt, completedAt: new Date().toISOString(), mode: options.checksOnly ? "checks-only" : "full",
    ...code, strategy: options.strategy, dataset: dataset.metadata, rubric: FAITHFULNESS,
    modelConfiguration: { ...MODELS, escalationBuffer: ESCALATE_BUFFER, maxTokens: MAX_TOKENS, requestPolicy: REQUEST_POLICY },
  }, rows);
  const markdown = buildReport(run);
  try {
    writeArtifact(join(options.outputDir, "results.json"), `${JSON.stringify(run, null, 2)}\n`);
    writeArtifact(join(options.outputDir, "report.md"), markdown);
  } catch { throw new Error("Cannot write result artifacts."); }
  if (!options.quiet) console.log(`\n${markdown}`);
  console.error(`Wrote results.json and report.md. Cases: ${rows.length}; evaluation errors: ${run.metrics.errors}.`);
  return run.metrics.errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    // Only locally constructed, sanitized errors leave main; never print stack traces or raw upstream data.
    console.error(error instanceof Error ? error.message : "Run failed.");
    process.exitCode = 1;
  });
}
