import { FAITHFULNESS } from "./rubric.js";
import type { Case } from "./types.js";

export const CASE: Case = { id: "synthetic-case", context: "The total is 318.", question: "What is the total?", answer: "The total is 318.", label: "faithful" };

export const rubricResponse = (scores = [5, 5, 5, 5], flags: string[] = []) => ({
  status: "evaluated", reason: null,
  dimensions: FAITHFULNESS.dimensions.map((d, i) => ({ name: d.name, score: scores[i], evidence: `Evidence for ${d.name}` })), flags,
});
export const groundingResponse = (unsupported: string[] = []) => ({ status: "evaluated", reason: null, unsupported });
export const rubricAbstention = { status: "abstained", reason: "Conflicting source statements.", dimensions: [], flags: [] };
export const groundingAbstention = { status: "abstained", reason: "Ambiguous attribution.", unsupported: [] };

export function envelope(result: unknown, stopReason = "end_turn", model = "claude-haiku-4-5-20251001") {
  return { model, stop_reason: stopReason, content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
    usage: { input_tokens: 123, output_tokens: 45 } };
}

export function mockFetch(responses: unknown[]): typeof fetch {
  let index = 0;
  return async () => {
    if (index >= responses.length) throw new Error("Unexpected mock request");
    return Response.json(responses[index++]);
  };
}
