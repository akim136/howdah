import type { Case, ErrorCode } from "./types.js";

export class EvaluationError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function requireSchema(condition: unknown): asserts condition {
  if (!condition) throw new EvaluationError("INVALID_SCHEMA");
}

export function parseObject(raw: string, keys: string[]): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new EvaluationError("INVALID_JSON"); }
  requireSchema(isRecord(value));
  requireSchema(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  return value;
}

export function stringList(value: unknown): string[] {
  requireSchema(Array.isArray(value) && value.every(nonemptyString));
  return value;
}

/** Validate the entire file before the runner is allowed to call a judge. */
export function validateDataset(value: unknown): Case[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Dataset must be a nonempty array.");
  const ids = new Set<string>();
  return value.map((row: unknown, index) => {
    const fail = () => new Error(`Invalid dataset row ${index + 1}: require a unique nonempty id, string context/question/answer, a valid label, and optional string note.`);
    if (!isRecord(row) || !nonemptyString(row.id) || row.id !== row.id.trim()
      || ids.has(row.id) || typeof row.context !== "string" || typeof row.question !== "string"
      || typeof row.answer !== "string" || (row.label !== "faithful" && row.label !== "unfaithful")
      || (Object.hasOwn(row, "note") && typeof row.note !== "string")) throw fail();
    ids.add(row.id);
    return { id: row.id, context: row.context, question: row.question, answer: row.answer, label: row.label,
      ...(typeof row.note === "string" ? { note: row.note } : {}) };
  });
}

export function parseDataset(raw: string): Case[] {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Dataset is not valid JSON."); }
  return validateDataset(value);
}
