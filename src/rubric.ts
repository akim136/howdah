/**
 * Faithfulness rubric + judge-prompt builder/parser. Dimensions are weighted; the judge scores each
 * 1-5 with evidence and lists disqualifying flags. Mirrors the rubric pattern used in production
 * eval harnesses, generalized to RAG/agent answer faithfulness.
 */
import type { Case, JudgeDimension, JudgeResult } from "./types.js";

export interface Rubric {
  threshold: number; // overall pass on a 1-5 scale
  dimensions: { name: string; weight: number; guidance: string }[];
}

export const FAITHFULNESS: Rubric = {
  threshold: 4.0,
  dimensions: [
    { name: "supported_by_context", weight: 0.4, guidance: "Every claim in the answer is directly supported by the context." },
    { name: "no_fabrication", weight: 0.3, guidance: "No invented facts, numbers, entities, or relationships beyond the context." },
    { name: "completeness", weight: 0.15, guidance: "Uses the relevant supported facts to actually answer the question (no needless omission)." },
    { name: "appropriate_refusal", weight: 0.15, guidance: "If the context does not contain the answer, it says so rather than guessing." },
  ],
};

export function buildJudgePrompt(rubric: Rubric, c: Case): string {
  const dims = rubric.dimensions.map((d) => `- ${d.name}: ${d.guidance}`).join("\n");
  return [
    `You are a strict evaluator of an ANSWER's faithfulness to its CONTEXT for a given QUESTION.`,
    `Score each dimension 1 (poor) to 5 (excellent) with one sentence of specific evidence.`,
    `Dimensions:`,
    dims,
    ``,
    `Also list any disqualifying problems as short flags (e.g. fabricated-number, invented-entity,`,
    `unsupported-claim, should-have-refused).`,
    ``,
    `QUESTION:`,
    c.question,
    ``,
    `CONTEXT (the only source of truth):`,
    c.context,
    ``,
    `ANSWER:`,
    c.answer,
    ``,
    `Reply with ONLY JSON: {"dimensions":[{"name":"<dimension>","score":<1-5>,"evidence":"<one sentence>"}],"flags":["<short flag>"]}`,
  ].join("\n");
}

export function parseJudge(rubric: Rubric, raw: string): { dimensions: JudgeDimension[]; flags: string[]; overall: number } {
  let json: { dimensions?: { name?: string; score?: number; evidence?: string }[]; flags?: string[] };
  try {
    json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    // Malformed judge response — degrade to a flagged, mid verdict rather than crash.
    json = { dimensions: [], flags: ["judge response unparseable"] };
  }
  const byName = new Map((json.dimensions ?? []).map((d) => [d.name, d]));
  let weighted = 0;
  let weightSum = 0;
  const dimensions: JudgeDimension[] = rubric.dimensions.map((rd) => {
    const got = byName.get(rd.name);
    const score = typeof got?.score === "number" ? Math.max(1, Math.min(5, got.score)) : 3;
    weighted += score * rd.weight;
    weightSum += rd.weight;
    return { name: rd.name, score, max: 5, evidence: got?.evidence ?? "" };
  });
  const overall = weightSum > 0 ? weighted / weightSum : 0;
  return { dimensions, flags: (json.flags ?? []).filter(Boolean).map(String), overall: Math.round(overall * 100) / 100 };
}

/** Merge rubric score + grounding flags into a final verdict (faithful = passes AND no grounding flags). */
export function verdict(
  rubric: Rubric,
  parsed: { dimensions: JudgeDimension[]; flags: string[]; overall: number },
  groundingFlags: string[],
  model: string,
  escalated: boolean,
): JudgeResult {
  const flags = [...parsed.flags, ...groundingFlags.map((g) => `unsupported: ${g}`)];
  return {
    model,
    overall: parsed.overall,
    faithful: parsed.overall >= rubric.threshold && groundingFlags.length === 0,
    dimensions: parsed.dimensions,
    flags,
    escalated,
  };
}
