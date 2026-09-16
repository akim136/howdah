/** One public or synthetic answer and its human annotation. Annotations never enter prompts. */
export interface Case {
  id: string;
  context: string;
  question: string;
  answer: string;
  label: "faithful" | "unfaithful";
  note?: string;
}

export type Outcome = "faithful" | "unfaithful" | "abstained" | "error" | "skipped";
export type Strategy = "haiku" | "sonnet" | "cascade";

/** Advisory review signals, not a faithfulness verdict. */
export interface CheckResult {
  ok: boolean;
  failures: string[];
  stats: { words: number; refused: number; unsupportedNumbers: number };
  numberSignals: string[];
}

export interface JudgeDimension {
  name: string;
  score: number;
  max: 5;
  evidence: string;
}

export interface Abstention {
  status: "abstained";
  reason: string;
}

export type RubricResult = Abstention | {
  status: "evaluated";
  reason: null;
  dimensions: JudgeDimension[];
  flags: string[];
  faithfulnessScore: number;
  answerQualityScore: number;
};

export type GroundingResult = Abstention | {
  status: "evaluated";
  reason: null;
  unsupported: string[];
};

export type ErrorCode =
  | "REQUEST_TIMEOUT" | "NETWORK_ERROR" | "RATE_LIMIT" | "SERVER_ERROR"
  | "AUTH_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE" | "INVALID_JSON"
  | "INVALID_SCHEMA" | "EVALUATOR_REFUSAL" | "OUTPUT_TRUNCATED"
  | "UNEXPECTED_STOP" | "INTERNAL_ERROR";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Only allowlisted diagnostics survive a request; no raw response or exception text. */
export interface Attempt {
  latencyMs: number;
  httpStatus: number | null;
  responseModel: string | null;
  stopReason: "end_turn" | "refusal" | "max_tokens" | "other" | null;
  usage: TokenUsage | null;
  errorCode: ErrorCode | null;
}

interface StageBase {
  model: string;
  latencyMs: number;
  retryCount: number;
  attempts: Attempt[];
}

export type StageResult = StageBase & (
  | { kind: "rubric"; result: RubricResult; errorCode: null }
  | { kind: "grounding"; result: GroundingResult; errorCode: null }
  | { kind: "rubric" | "grounding"; result: null; errorCode: ErrorCode }
);

export interface JudgeResult {
  outcome: Exclude<Outcome, "skipped">;
  reason: string | null;
  errorCode: ErrorCode | null;
  model: string | null;
  faithfulnessScore: number | null;
  answerQualityScore: number | null;
  dimensions: JudgeDimension[];
  flags: string[];
  escalated: boolean;
  stages: StageResult[];
}

export interface Row {
  id: string;
  gold: Case["label"];
  outcome: Outcome;
  checks: CheckResult;
  evaluation: JudgeResult | null;
}
