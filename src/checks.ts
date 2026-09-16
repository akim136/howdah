/**
 * Deterministic, no-LLM checks. Cheap and free — they run without an API key and catch the obvious
 * review signals (empty/over-long answers and numbers absent from the context).
 * These signals do not prove fabrication: valid arithmetic can introduce new numbers.
 */
import type { Case, CheckResult } from "./types.js";

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** True if the answer looks like an explicit refusal / "not in the context". */
export function looksLikeRefusal(answer: string): boolean {
  return /\b(i (don'?t|do not) (know|have enough)|cannot (answer|determine)|does(n'?t| not) (break|include|specify|contain|cover|provide|state|mention|list|say|indicate)|not (stated|mentioned|provided|specified|in the (context|passage|document))|no (information|mention)|isn'?t (stated|mentioned|specified))\b/i.test(
    answer,
  );
}

/** Compare entire number tokens, ignoring thousands separators and percent signs. Advisory only. */
export function unsupportedNumbers(answer: string, context: string): string[] {
  const tokens = (s: string) => s.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, (n) => n.replace(/,/g, ""))
    .match(/\d+(?:\.\d+)?%?/g) ?? [];
  const bare = (n: string) => n.replace(/%$/, "");
  const ctx = new Set(tokens(context).map(bare));
  return [...new Set(tokens(answer).filter((n) => !ctx.has(bare(n))))];
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
    numberSignals: badNums,
  };
}
