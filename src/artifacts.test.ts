import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComparisonArtifacts } from "./artifacts.js";
import { summarizeComparison } from "./comparison.js";
import { trialRun } from "./comparison-fixtures.js";

const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "howdah-artifacts-")); dirs.push(dir); return dir; };
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("isolated comparison publication", () => {
  it("publishes a complete pair per trial and a manifest whose hashes match every artifact", () => {
    const bundle = new ComparisonArtifacts(directory(), 1);
    const trial = trialRun("haiku", 1);
    bundle.writeTrial(trial);
    expect(existsSync(bundle.destination)).toBe(false);
    expect(json(join(bundle.staging, "manifest.json")).status).toBe("running");
    const destination = bundle.finish(summarizeComparison([trial], null));
    expect(existsSync(bundle.staging)).toBe(false);
    const manifest = json(join(destination, "manifest.json"));
    expect(manifest.status).toBe("complete");
    const files = [...manifest.runs.flatMap((run: { files: unknown[] }) => run.files), ...manifest.summary] as { path: string; sha256: string }[];
    expect(files).toHaveLength(4);
    for (const file of files) expect(createHash("sha256").update(readFileSync(join(destination, file.path))).digest("hex")).toBe(file.sha256);
  });

  it("isolates simultaneous runs with the same output parent", () => {
    const parent = directory();
    const a = new ComparisonArtifacts(parent, 1);
    const b = new ComparisonArtifacts(parent, 1);
    expect(a.destination).not.toBe(b.destination);
    const trial = trialRun("sonnet", 1);
    a.writeTrial(trial); b.writeTrial(trial);
    a.finish(summarizeComparison([trial], null)); b.finish(summarizeComparison([trial], null));
    expect(readdirSync(parent)).toHaveLength(2);
  });

  it("retains completed trials after failure and never calls a partial bundle complete", () => {
    const bundle = new ComparisonArtifacts(directory(), 2);
    bundle.writeTrial(trialRun("haiku", 1));
    expect(() => bundle.finish(summarizeComparison([trialRun("haiku", 1)], null))).toThrow("incomplete");
    bundle.fail();
    const manifest = json(join(bundle.staging, "manifest.json"));
    expect(manifest).toMatchObject({ status: "failed", plannedRuns: 2 });
    expect(manifest.runs).toHaveLength(1);
    expect(existsSync(join(bundle.staging, "haiku-trial-001/results.json"))).toBe(true);
    expect(existsSync(bundle.destination)).toBe(false);
  });

  it("refuses duplicate trial writes or a destination collision", () => {
    const bundle = new ComparisonArtifacts(directory(), 1);
    const trial = trialRun("haiku", 1);
    bundle.writeTrial(trial);
    expect(() => bundle.finish(summarizeComparison([trialRun("sonnet", 1)], null))).toThrow("mismatched");
    const before = readFileSync(join(bundle.staging, "haiku-trial-001/results.json"), "utf8");
    expect(() => bundle.writeTrial(trial)).toThrow();
    expect(readFileSync(join(bundle.staging, "haiku-trial-001/results.json"), "utf8")).toBe(before);
    mkdirSync(bundle.destination);
    expect(() => bundle.finish(summarizeComparison([trial], null))).toThrow("duplicate");
    expect(readdirSync(bundle.destination)).toEqual([]);
  });
});
