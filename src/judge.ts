/** Haiku screens each nonempty answer; a valid Sonnet escalation supplies the final judgment. */
import { buildGroundingPrompt, GROUNDING_SCHEMA, parseGrounding } from "./grounding.js";
import { buildJudgePrompt, judgeSchema, parseJudge, verdict, type Rubric } from "./rubric.js";
import { requestJson, type RequestOptions } from "./transport.js";
import type { Case, ErrorCode, JudgeResult, StageResult, Strategy } from "./types.js";

export const MODELS = { screen: "claude-haiku-4-5-20251001", escalation: "claude-sonnet-4-6" } as const;
export const ESCALATE_BUFFER = 0.5;
export const STRATEGIES: readonly Strategy[] = ["haiku", "sonnet", "cascade"];

export interface JudgeOptions extends RequestOptions {
  rubric: Rubric;
  strategy?: Strategy;
}

export function evaluationError(code: ErrorCode, stages: StageResult[] = [], escalated = false): JudgeResult {
  return { outcome: "error", reason: code, errorCode: code, model: stages.at(-1)?.model ?? null,
    faithfulnessScore: null, answerQualityScore: null, dimensions: [], flags: [], escalated, stages };
}

export async function judge(c: Case, opts: JudgeOptions): Promise<JudgeResult> {
  const strategy = opts.strategy ?? "cascade";
  if (!STRATEGIES.includes(strategy)) throw new Error("Unknown judge strategy.");
  if (!c.answer.trim()) return {
    outcome: "abstained", reason: "empty answer", errorCode: null, model: null,
    faithfulnessScore: null, answerQualityScore: null, dimensions: [], flags: [], escalated: false, stages: [],
  };
  const stages: StageResult[] = [];
  const { rubric } = opts;
  const models = strategy === "haiku" ? [MODELS.screen] : strategy === "sonnet" ? [MODELS.escalation] : [MODELS.screen, MODELS.escalation];
  for (const [index, model] of models.entries()) {
    const escalated = strategy === "cascade" && index > 0;
    const rubricCall = await requestJson(model, buildJudgePrompt(rubric, c), judgeSchema(rubric), (raw) => parseJudge(rubric, raw), opts);
    if (rubricCall.result === null) {
      const code = rubricCall.errorCode ?? "INTERNAL_ERROR";
      stages.push({ ...rubricCall, kind: "rubric", model, result: null, errorCode: code });
      return evaluationError(code, stages, escalated);
    }
    stages.push({ ...rubricCall, kind: "rubric", model, result: rubricCall.result, errorCode: null });
    const groundingCall = await requestJson(model, buildGroundingPrompt(c.answer, c.context), GROUNDING_SCHEMA, parseGrounding, opts);
    if (groundingCall.result === null) {
      const code = groundingCall.errorCode ?? "INTERNAL_ERROR";
      stages.push({ ...groundingCall, kind: "grounding", model, result: null, errorCode: code });
      return evaluationError(code, stages, escalated);
    }
    stages.push({ ...groundingCall, kind: "grounding", model, result: groundingCall.result, errorCode: null });
    const result = verdict(rubric, rubricCall.result, groundingCall.result);
    const shouldEscalate = result.outcome !== "faithful" || (result.faithfulnessScore ?? 0) < rubric.threshold + ESCALATE_BUFFER;
    if (index === models.length - 1 || !shouldEscalate) return { ...result, model, escalated, errorCode: null, stages };
  }
  return evaluationError("INTERNAL_ERROR", stages);
}
