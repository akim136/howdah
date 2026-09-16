import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./run.js";
import type { RunResult } from "./reporting.js";
import { CASE, envelope, groundingAbstention, groundingResponse, rubricAbstention, rubricResponse } from "./test-fixtures.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Actual CLI subprocess, with a preload that makes network access impossible. */
function runFixture(cases: unknown, responses: { body: unknown; status?: number }[] = [], args: string[] = [], apiKey = "synthetic-test-key",
  fault?: "output-is-file" | "report-becomes-directory" | "output-aliases-dataset") {
  const directory = mkdtempSync(join(tmpdir(), "howdah-cli-"));
  temporaryDirectories.push(directory);
  const dataset = join(directory, fault === "output-aliases-dataset" ? "results.json" : "custom cases.json");
  const output = join(directory, "output");
  const marker = join(directory, "requests.txt");
  const preload = join(directory, "mock-fetch.mjs");
  if (fault === "output-is-file") writeFileSync(output, "Existing file must be preserved.");
  if (fault === "output-aliases-dataset") symlinkSync(directory, output, "dir");
  const raw = typeof cases === "string" ? cases : JSON.stringify(cases);
  writeFileSync(dataset, raw);
  writeFileSync(preload, `import { appendFileSync, mkdirSync } from 'node:fs';
const replies = ${JSON.stringify(responses)};
globalThis.fetch = async () => {
  appendFileSync(${JSON.stringify(marker)}, 'request\\n');
  const reply = replies.shift();
  if (!reply) throw new Error('unexpected request: no network available');
  if (replies.length === 0 && ${fault === "report-becomes-directory"}) mkdirSync(${JSON.stringify(join(output, "report.md"))});
  return Response.json(reply.body, { status: reply.status ?? 200 });
};
`);
  const child = spawnSync(process.execPath, ["--import", preload, "--import", "tsx", "src/run.ts", "--dataset", dataset, "--output-dir", output, ...args],
    { cwd: root, env: { ...process.env, ANTHROPIC_API_KEY: apiKey }, encoding: "utf8", timeout: 10_000 });
  if (child.error) throw child.error;
  return {
    ...child, dataset, raw, output,
    calls: existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0,
    read: () => JSON.parse(readFileSync(join(output, "results.json"), "utf8")) as RunResult,
    report: () => readFileSync(join(output, "report.md"), "utf8"),
  };
}
const reply = (body: unknown) => ({ body: envelope(body) });

describe("CLI", () => {
  it.each(["haiku", "sonnet"])("records the selected %s strategy without escalation", (strategy) => {
    const child = runFixture([CASE], [reply(rubricResponse([1, 1, 5, 5])), reply(groundingResponse())], ["--strategy", strategy, "--quiet"]);
    expect(child.status).toBe(0);
    expect(child.calls).toBe(2);
    expect(child.read().metadata.strategy).toBe(strategy);
    expect(child.read().rows[0]?.evaluation?.escalated).toBe(false);
    expect(child.report()).toContain(`Strategy: ${strategy}`);
  });
  it("rejects an unknown strategy before requests", () => {
    const child = runFixture([CASE], [], ["--strategy", "unknown"]);
    expect(child.status).toBe(1);
    expect(child.calls).toBe(0);
  });
  it("writes versioned checks-only artifacts with every case skipped and zero API calls", () => {
    const child = runFixture([CASE, { ...CASE, id: "empty", answer: "" }], [], ["--checks-only", "--quiet"], "");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.calls).toBe(0);
    const result = child.read();
    expect(result).toMatchObject({ schemaVersion: "2.0", metadata: { mode: "checks-only", dataset: { file: "custom cases.json", sha256: createHash("sha256").update(child.raw).digest("hex") }, rubric: { version: "faithfulness-v2" } }, metrics: { skipped: 2, coverage: 0, errors: 0 } });
    expect(result.rows.map((row) => row.outcome)).toEqual(["skipped", "skipped"]);
    expect(result.rows[1]?.checks.failures).toContain("empty answer");
    expect(result.metadata.codeRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(child.report()).toContain("Mode: checks-only");
  });

  it.each(["", " ", "sk-ant-your-key-here"])("fails clearly when full-mode credentials are missing or a placeholder (%#)", (key) => {
    const child = runFixture([CASE], [], [], key);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Full mode requires ANTHROPIC_API_KEY");
    expect(child.calls).toBe(0);
    expect(existsSync(join(child.output, "results.json"))).toBe(false);
  });

  it.each(["private invalid JSON", [], [CASE, CASE], [CASE, { ...CASE, id: "bad", label: "unknown" }]]
    .map((cases) => ({ cases })))("validates the entire dataset before making any requests (%#)", ({ cases }) => {
    const child = runFixture(cases);
    expect(child.status).toBe(1);
    expect(child.calls).toBe(0);
    expect(child.stderr).not.toContain("private invalid JSON");
    expect(existsSync(join(child.output, "results.json"))).toBe(false);
  });

  it("returns nonzero for an all-error run and keeps every sanitized case", () => {
    const child = runFixture([CASE, { ...CASE, id: "second" }], [
      { body: { private: "upstream body with credentials" }, status: 401 }, reply("malformed private evaluator text"),
    ], ["--quiet"]);
    expect(child.status).toBe(1);
    expect(child.read().metrics).toMatchObject({ total: 2, errors: 2, classified: 0, coverage: 0, accuracy: null });
    expect(child.read().rows.map((r) => r.evaluation?.errorCode)).toEqual(["AUTH_ERROR", "INVALID_JSON"]);
    expect(child.report()).toContain("| Errors | 2 |");
    for (const output of [child.stdout, child.stderr, child.report(), JSON.stringify(child.read())]) {
      expect(output).not.toContain("upstream body with credentials");
      expect(output).not.toContain("malformed private evaluator text");
      expect(output).not.toContain("synthetic-test-key");
    }
  });

  it("preserves successful rows around a case error and exits nonzero", () => {
    const child = runFixture([CASE, { ...CASE, id: "bad" }, { ...CASE, id: "last" }], [
      reply(rubricResponse()), reply(groundingResponse()), reply("{}"), reply(rubricResponse()), reply(groundingResponse()),
    ]);
    expect(child.status).toBe(1);
    expect(child.read().rows.map((r) => r.outcome)).toEqual(["faithful", "error", "faithful"]);
    expect(child.read().metrics.coverage).toBe(2 / 3);
    expect(child.stdout).toContain("# Faithfulness evaluation");
  });

  it("reports poor classification as a completed run with exit code zero", () => {
    const child = runFixture([{ ...CASE, label: "unfaithful" }], [reply(rubricResponse()), reply(groundingResponse())], ["--quiet"]);
    expect(child.status).toBe(0);
    expect(child.read().metrics).toMatchObject({ accuracy: 0, f1: 0, errors: 0, confusion: { fn: 1 } });
  });

  it("retains model abstentions and local empty-answer abstentions without counting them as errors", () => {
    const child = runFixture([CASE, { ...CASE, id: "empty", answer: " " }], [
      reply(rubricAbstention), reply(groundingAbstention), reply(rubricAbstention), reply(groundingAbstention),
    ], ["--quiet"]);
    expect(child.status).toBe(0);
    expect(child.read().metrics).toMatchObject({ abstained: 2, errors: 0, coverage: 0 });
    expect(child.calls).toBe(4);
    expect(child.read().rows[1]?.evaluation?.reason).toBe("empty answer");
  });

  it("rejects invalid CLI arguments without silently changing mode", () => {
    expect(() => parseArgs(["--dataset"])).toThrow("requires a path");
    expect(() => parseArgs(["--output-dir", "--quiet"])).toThrow("requires a path");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument");
    expect(() => parseArgs(["--dataset", join(root, "results.json")])).toThrow("Dataset path must differ");
    const child = runFixture([CASE], [], ["--unknown"]);
    expect(child.status).toBe(1);
    expect(child.calls).toBe(0);
  });

  it("fails before making requests when the output directory is unusable", () => {
    const child = runFixture([CASE], [], [], "test", "output-is-file");
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Cannot use output directory");
    expect(child.calls).toBe(0);
    expect(readFileSync(child.output, "utf8")).toBe("Existing file must be preserved.");
  });

  it("rejects output directories that alias the dataset through a symlink", () => {
    const child = runFixture([CASE], [reply(rubricResponse()), reply(groundingResponse())], ["--quiet"], "test", "output-aliases-dataset");
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Dataset path must differ from output artifact paths");
    expect(child.calls).toBe(0);
    expect(readFileSync(child.dataset, "utf8")).toBe(child.raw);
    expect(existsSync(join(child.output, "report.md"))).toBe(false);
  });

  it("reports a late artifact write failure, preserving JSON and removing temporary files", () => {
    const child = runFixture([CASE], [reply(rubricResponse()), reply(groundingResponse())], ["--quiet"], "test", "report-becomes-directory");
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Cannot write result artifacts");
    expect(child.read().rows[0]?.outcome).toBe("faithful");
    expect(readdirSync(child.output).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
