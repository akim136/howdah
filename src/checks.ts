/**
 * Deterministic, no-LLM checks. Cheap and free — they run without an API key and catch the obvious
 * failure modes (empty/over-long answers) plus one genuinely useful fabrication heuristic: numbers
 * asserted in the answer that never appear in the context (a common, machine-detectable hallucination).
 * They don't replace the judge; they're the fast first layer.
 */
import type { Case, CheckResult } from "./types.js";

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** True if the answer looks like an explicit refusal / "not in the context". */
export function looksLikeRefusal(answer: string): boolean {
  return /\b(i (don'?t|do not) (know|have enough)|cannot (answer|determine)|does(n'?t| not) (break|include|specify|contain|cover|provide|state|mention|list|say|indicate)|not (stated|mentioned|provided|specified|in the (context|passage|document))|no (information|mention)|isn'?t (stated|mentioned|specified))\b/i.test(
    answer,
  );
}

/** Numbers stated in the answer that do not appear anywhere in the context (fabrication heuristic). */
export function unsupportedNumbers(answer: string, context: string): string[] {
  const norm = (s: string) => s.replace(/,/g, "");
  const ctx = norm(context);
  const nums = norm(answer).match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
  const out: string[] = [];
  for (const n of nums) {
    const bare = n.replace(/%$/, "");
    if (!ctx.includes(bare)) out.push(n);
  }
  return [...new Set(out)];
}

export function check(c: Case): CheckResult {
  const f: string[] = [];
  const a = c.answer.trim();
  if (!a) f.push("empty answer");
  const w = words(a);
  if (w > 250) f.push(`answer very long (${w} words)`);
  const refused = looksLikeRefusal(a);
  const badNums = a ? unsupportedNumbers(a, c.context) : [];
  return {
    ok: f.length === 0,
    failures: f,
    stats: { words: w, refused: refused ? 1 : 0, unsupportedNumbers: badNums.length },
  };
}
