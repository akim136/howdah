import { UNTRUSTED_INPUT, type EvaluatorPrompt } from "./rubric.js";
import type { GroundingResult } from "./types.js";
import { nonemptyString, parseObject, requireSchema, stringList } from "./validation.js";

export function buildGroundingPrompt(answer: string, context: string): EvaluatorPrompt {
  return {
    system: [
      "Verify the answer against its context, the only source of truth.",
      UNTRUSTED_INPUT,
      "List every unsupported or contradicted factual claim, number, entity, date, attribution, or relationship asserted in the answer.",
      "Faithful rephrasings, supported summaries, and valid arithmetic derived from context are supported. Omissions and refusal style are quality issues, not unsupported claims.",
      "An answer correctly saying the context lacks information has nothing to flag.",
      "Return status evaluated, reason null, and an unsupported array (empty when there are no unsupported claims).",
      "If conflicting sources or ambiguous evidence prevent a judgment, return status abstained with a nonempty reason and an empty unsupported array.",
    ].join("\n"),
    data: JSON.stringify({ context, answer }),
  };
}

export const GROUNDING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["status", "reason", "unsupported"],
  properties: {
    status: { type: "string", enum: ["evaluated", "abstained"] },
    reason: { type: ["string", "null"] },
    unsupported: { type: "array", items: { type: "string" } },
  },
};

export function parseGrounding(raw: string): GroundingResult {
  const json = parseObject(raw, ["status", "reason", "unsupported"]);
  const unsupported = stringList(json.unsupported);
  if (json.status === "abstained") {
    requireSchema(nonemptyString(json.reason) && unsupported.length === 0);
    return { status: "abstained", reason: json.reason };
  }
  requireSchema(json.status === "evaluated" && json.reason === null);
  return { status: "evaluated", reason: null, unsupported };
}
