/**
 * LLM-as-judge with a cost cascade: Haiku screens every answer (rubric + grounding); borderline or
 * flagged ones (low score, rubric flags, or any grounding flag) escalate to Sonnet for a rigorous
 * second opinion. Most answers settle on the cheap model; only the hard calls pay for the strong one.
 */
import { buildGroundingPrompt, parseGrounding } from "./grounding.js";
import { buildJudgePrompt, parseJudge, verdict, type Rubric } from "./rubric.js";
import type { Case, JudgeResult } from "./types.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const ESCALATE_BUFFER = 0.5; // re-judge with Sonnet when within this of the threshold

async function callJson(model: string, apiKey: string, prompt: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${model} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? "";
}

export interface JudgeOptions {
  apiKey: string;
  rubric: Rubric;
  fetchImpl?: typeof fetch;
}

/** Judge one case's answer. Throws if the API call fails (caller decides how to handle). */
export async function judge(c: Case, opts: JudgeOptions): Promise<JudgeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { rubric } = opts;
  const judgePrompt = buildJudgePrompt(rubric, c);
  const groundingPrompt = buildGroundingPrompt(c.answer, c.context);

  // 1. Haiku screen (rubric + grounding).
  let parsed = parseJudge(rubric, await callJson(HAIKU, opts.apiKey, judgePrompt, fetchImpl));
  let grounding = parseGrounding(await callJson(HAIKU, opts.apiKey, groundingPrompt, fetchImpl));

  // 2. Escalate to Sonnet when the verdict is borderline/failing or anything was flagged.
  const borderline = parsed.overall < rubric.threshold + ESCALATE_BUFFER;
  if (borderline || parsed.flags.length > 0 || grounding.length > 0) {
    parsed = parseJudge(rubric, await callJson(SONNET, opts.apiKey, judgePrompt, fetchImpl));
    grounding = parseGrounding(await callJson(SONNET, opts.apiKey, groundingPrompt, fetchImpl));
    return verdict(rubric, parsed, grounding, SONNET, true);
  }
  return verdict(rubric, parsed, grounding, HAIKU, false);
}
