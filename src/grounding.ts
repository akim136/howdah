/**
 * No-fabrication grounding check: given an answer and its context, list every factual claim,
 * number, entity, or relationship the answer asserts that the context does NOT support. This is the
 * core hallucination detector — independent of the rubric score, and any flag fails the case.
 */

export function buildGroundingPrompt(answer: string, context: string): string {
  return [
    `You verify an ANSWER against its CONTEXT (the only source of truth it may use).`,
    `List every factual claim, number, named entity, date, or relationship asserted in the ANSWER`,
    `that is NOT supported by the CONTEXT. Be precise: flag only things that are actually absent or`,
    `contradicted, not faithful rephrasings or reasonable summaries of supported facts. An answer that`,
    `correctly says the context does not contain the requested information has nothing to flag.`,
    ``,
    `CONTEXT:`,
    context,
    ``,
    `ANSWER:`,
    answer,
    ``,
    `Reply with ONLY JSON: {"unsupported":["<short description of each unsupported claim>"]}`,
  ].join("\n");
}

export function parseGrounding(raw: string): string[] {
  try {
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { unsupported?: string[] };
    return (json.unsupported ?? []).filter(Boolean).map(String);
  } catch {
    return [];
  }
}
