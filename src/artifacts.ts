import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildComparisonReport, type ComparisonSummary, type TrialRun } from "./comparison.js";
import { STRATEGIES } from "./judge.js";
import { buildReport } from "./reporting.js";
import type { Strategy } from "./types.js";

interface Artifact { path: string; sha256: string }
interface Manifest {
  schemaVersion: "comparison-manifest-v1";
  status: "running" | "complete" | "failed";
  plannedRuns: number;
  runs: { strategy: Strategy; trial: number; files: Artifact[] }[];
  summary: Artifact[];
}

/** Each invocation owns a fresh directory. Only a complete bundle gets its public name. */
export class ComparisonArtifacts {
  readonly staging: string;
  readonly destination: string;
  private readonly manifest: Manifest;
  private published = false;

  constructor(parent: string, plannedRuns: number) {
    mkdirSync(parent, { recursive: true });
    this.staging = mkdtempSync(join(parent, ".comparison-"));
    this.destination = join(parent, basename(this.staging).slice(1));
    this.manifest = { schemaVersion: "comparison-manifest-v1", status: "running", plannedRuns, runs: [], summary: [] };
    this.writeManifest();
  }

  private write(relative: string, content: string): Artifact {
    writeFileSync(join(this.staging, relative), content, { encoding: "utf8", flag: "wx" });
    return { path: relative, sha256: createHash("sha256").update(content).digest("hex") };
  }

  private writeManifest(): void {
    const temporary = join(this.staging, `.manifest-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(this.manifest, null, 2)}\n`, { flag: "wx" });
      renameSync(temporary, join(this.staging, "manifest.json"));
    } finally { rmSync(temporary, { force: true }); }
  }

  writeTrial(trial: TrialRun): void {
    if (this.published || this.manifest.status !== "running" || !STRATEGIES.includes(trial.strategy)
      || !Number.isSafeInteger(trial.trial) || trial.trial < 1 || trial.trial > 20) throw new Error("Invalid trial publication.");
    const directory = `${trial.strategy}-trial-${String(trial.trial).padStart(3, "0")}`;
    mkdirSync(join(this.staging, directory)); // Refuse a duplicate; never overwrite another trial.
    const files = [this.write(`${directory}/results.json`, `${JSON.stringify(trial.run, null, 2)}\n`),
      this.write(`${directory}/report.md`, buildReport(trial.run))];
    this.manifest.runs.push({ strategy: trial.strategy, trial: trial.trial, files });
    this.writeManifest();
  }

  finish(summary: ComparisonSummary): string {
    if (this.published || this.manifest.status !== "running" || this.manifest.runs.length !== this.manifest.plannedRuns
      || existsSync(this.destination)
      || JSON.stringify(summary.metadata.executionOrder) !== JSON.stringify(this.manifest.runs.map(({ strategy, trial }) => ({ strategy, trial }))))
      throw new Error("Cannot publish an incomplete, mismatched, or duplicate comparison.");
    this.manifest.summary = [this.write("comparison.json", `${JSON.stringify(summary, null, 2)}\n`),
      this.write("comparison.md", buildComparisonReport(summary))];
    this.manifest.status = "complete";
    this.writeManifest();
    renameSync(this.staging, this.destination);
    this.published = true;
    return this.destination;
  }

  fail(): void {
    if (!this.published) {
      this.manifest.status = "failed";
      this.writeManifest();
    }
  }
}
