/** Shared types for the faithfulness eval harness. */

/** One labeled evaluation case: an answer to be judged for faithfulness to its context. */
export interface Case {
  id: string;
  /** The source material the answer must stay faithful to. */
  context: string;
  question: string;
  /** The (model-generated) answer under evaluation. */
  answer: string;
  /** Gold label: is the answer faithful to the context (no fabrication/over-claim)? */
  label: "faithful" | "unfaithful";
  /** Why it's labeled that way (for the dataset reader; not shown to the judge). */
  note?: string;
}

/** Deterministic, no-LLM check result. */
export interface CheckResult {
  ok: boolean;
  failures: string[];
  stats: Record<string, number | string>;
}

export interface JudgeDimension {
  name: string;
  score: number; // 1..max
  max: number;
  evidence: string;
}

/** LLM-as-judge verdict for one answer. */
export interface JudgeResult {
  model: string; // model that produced the final verdict
  overall: number; // weighted, 1..5
  /** Predicted faithful: passes the score threshold AND no grounding flags. */
  faithful: boolean;
  dimensions: JudgeDimension[];
  flags: string[]; // rubric disqualifiers + grounding/fabrication
  escalated: boolean; // Haiku → Sonnet happened
}
