import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./checks.js";
import { ESCALATE_BUFFER, evaluationError, judge, MODELS } from "./judge.js";
import { buildReport, createRun } from "./reporting.js";
import { FAITHFULNESS } from "./rubric.js";
import { MAX_TOKENS, REQUEST_POLICY } from "./transport.js";
import { parseDataset } from "./validation.js";
import type { Row } from "./types.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Minimal .env loader. An explicitly set environment variable (even empty) takes precedence. */
function loadEnv(): void {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
}

export function parseArgs(argv: string[]) {
  const options = { checksOnly: false, quiet: false, dataset: join(ROOT, "data/cases.json"), outputDir: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--checks-only") options.checksOnly = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--dataset" || arg === "--output-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path.`);
      options[arg === "--dataset" ? "dataset" : "outputDir"] = resolve(value);
    } else throw new Error("Unknown argument. Supported: --dataset PATH --output-dir PATH --checks-only --quiet.");
  }
  if (["results.json", "report.md"].some((name) => resolve(options.dataset) === join(options.outputDir, name)))
    throw new Error("Dataset path must differ from output artifact paths.");
  return options;
}

function revision(): { codeRevision: string | null; workingTreeDirty: boolean | null } {
  try {
    return {
      codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
      workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0,
    };
  } catch { return { codeRevision: null, workingTreeDirty: null }; }
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
  if (!options.checksOnly && process.env.ANTHROPIC_API_KEY === undefined) loadEnv();
  const startedAt = new Date().toISOString();
  let raw: Buffer;
  try { raw = readFileSync(options.dataset); }
  catch { throw new Error("Cannot read dataset file."); }
  const cases = parseDataset(raw.toString("utf8"));
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!options.checksOnly && (!apiKey || apiKey === "sk-ant-your-key-here"))
    throw new Error("Full mode requires ANTHROPIC_API_KEY. Set it or explicitly pass --checks-only.");
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
  const rows: Row[] = [];
  for (const c of cases) {
    const row: Row = { id: c.id, gold: c.label, outcome: "skipped", checks: check(c), evaluation: null };
    if (!options.checksOnly) {
      try { row.evaluation = await judge(c, { apiKey: apiKey!, rubric: FAITHFULNESS }); }
      catch { row.evaluation = evaluationError("INTERNAL_ERROR"); }
      row.outcome = row.evaluation.outcome;
    }
    rows.push(row);
    if (!options.quiet) process.stderr.write(`Case ${rows.length}/${cases.length}: ${row.outcome}\n`);
  }
  const run = createRun({ startedAt, completedAt: new Date().toISOString(), mode: options.checksOnly ? "checks-only" : "full",
    ...code, dataset: { file: basename(options.dataset), sha256: createHash("sha256").update(raw).digest("hex") }, rubric: FAITHFULNESS,
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
