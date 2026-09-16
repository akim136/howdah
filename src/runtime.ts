import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./checks.js";
import { evaluationError, judge } from "./judge.js";
import { FAITHFULNESS } from "./rubric.js";
import type { Case, Row, Strategy } from "./types.js";
import { parseDataset } from "./validation.js";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Explicit environment values (including empty) override .env. Checks-only never reads it. */
export function getApiKey(checksOnly: boolean): string | undefined {
  if (checksOnly) return undefined;
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    const path = join(ROOT, ".env");
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
      }
    }
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || key === "sk-ant-your-key-here") throw new Error("Full mode requires ANTHROPIC_API_KEY. Set it or explicitly pass --checks-only.");
  return key;
}

export function readDataset(path: string) {
  let raw: Buffer;
  try { raw = readFileSync(path); }
  catch { throw new Error("Cannot read dataset file."); }
  return { cases: parseDataset(raw.toString("utf8")), metadata: { file: basename(path), sha256: createHash("sha256").update(raw).digest("hex") } };
}

export function revision(): { codeRevision: string | null; workingTreeDirty: boolean | null } {
  try {
    return {
      codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
      workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0,
    };
  } catch { return { codeRevision: null, workingTreeDirty: null }; }
}

export async function evaluateCases(cases: Case[], options: {
  checksOnly: boolean; strategy: Strategy; apiKey?: string; fetchImpl?: typeof fetch;
  onProgress?: (row: Row, index: number) => void;
}): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const row: Row = { id: c.id, gold: c.label, outcome: "skipped", checks: check(c), evaluation: null };
    if (!options.checksOnly) {
      try { row.evaluation = await judge(c, { apiKey: options.apiKey!, rubric: FAITHFULNESS, strategy: options.strategy, fetchImpl: options.fetchImpl }); }
      catch { row.evaluation = evaluationError("INTERNAL_ERROR"); }
      row.outcome = row.evaluation.outcome;
    }
    rows.push(row);
    options.onProgress?.(row, rows.length);
  }
  return rows;
}
