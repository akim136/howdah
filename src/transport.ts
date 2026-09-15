import type { EvaluatorPrompt } from "./rubric.js";
import type { Attempt, ErrorCode, TokenUsage } from "./types.js";
import { EvaluationError, isRecord } from "./validation.js";

export const REQUEST_POLICY = { timeoutMs: 60_000, maxRetries: 2, backoffMs: [500, 1_000], maxBackoffMs: 5_000 } as const;
export const MAX_TOKENS = 1_600;

export interface RequestOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface RequestResult<T> {
  result: T | null;
  errorCode: ErrorCode | null;
  attempts: Attempt[];
  retryCount: number;
  latencyMs: number;
}

function usage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const counts = [value.input_tokens, value.output_tokens,
    value.cache_creation_input_tokens === undefined ? 0 : value.cache_creation_input_tokens,
    value.cache_read_input_tokens === undefined ? 0 : value.cache_read_input_tokens];
  if (!counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  return { inputTokens: counts[0] as number, outputTokens: counts[1] as number,
    cacheCreationInputTokens: counts[2] as number, cacheReadInputTokens: counts[3] as number };
}

function httpError(status: number): ErrorCode {
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

const transient = new Set<ErrorCode>(["NETWORK_ERROR", "REQUEST_TIMEOUT", "RATE_LIMIT", "SERVER_ERROR"]);

/** A timeout covers both headers and body. Even an injected fetch ignoring abort is bounded. */
async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EvaluationError("REQUEST_TIMEOUT"));
      controller.abort();
    }, REQUEST_POLICY.timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}

/** Fetch, validate, and retain bounded diagnostics. Never read HTTP error bodies. */
export async function requestJson<T>(model: string, prompt: EvaluatorPrompt, schema: Record<string, unknown>,
  parse: (raw: string) => T, options: RequestOptions): Promise<RequestResult<T>> {
  const started = performance.now();
  const attempts: Attempt[] = [];
  for (let retry = 0; retry <= REQUEST_POLICY.maxRetries; retry++) {
    const attempt: Attempt = { latencyMs: 0, httpStatus: null, responseModel: null, stopReason: null, usage: null, errorCode: null };
    attempts.push(attempt);
    const attemptStarted = performance.now();
    let retryAfterMs = 0;
    try {
      const result = await withTimeout(async (signal) => {
        let response: Response;
        try {
          response = await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
            method: "POST", signal, redirect: "error",
            headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: prompt.system,
              messages: [{ role: "user", content: prompt.data }], output_config: { format: { type: "json_schema", schema } } }),
          });
        } catch { throw new EvaluationError("NETWORK_ERROR"); }
        // A timed-out injected fetch can finish late; do not mutate its recorded attempt.
        if (signal.aborted) throw new EvaluationError("REQUEST_TIMEOUT");
        attempt.httpStatus = response.status;
        if (!response.ok) {
          const header = response.headers.get("retry-after");
          if (header) {
            const seconds = Number(header);
            const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
            if (Number.isFinite(delay)) retryAfterMs = Math.min(REQUEST_POLICY.maxBackoffMs, Math.max(0, delay));
          }
          void response.body?.cancel().catch(() => {});
          throw new EvaluationError(httpError(response.status));
        }
        let data: unknown;
        try { data = await response.json(); }
        catch (error) { throw new EvaluationError(error instanceof SyntaxError ? "INVALID_RESPONSE" : "NETWORK_ERROR"); }
        if (signal.aborted) throw new EvaluationError("REQUEST_TIMEOUT");
        if (!isRecord(data)) throw new EvaluationError("INVALID_RESPONSE");
        attempt.usage = usage(data.usage);
        attempt.responseModel = typeof data.model === "string" && /^claude-[a-zA-Z0-9.-]{1,100}$/.test(data.model) ? data.model : null;
        attempt.stopReason = data.stop_reason === "end_turn" || data.stop_reason === "refusal" || data.stop_reason === "max_tokens"
          ? data.stop_reason : data.stop_reason == null ? null : "other";
        if (data.stop_reason === "refusal") throw new EvaluationError("EVALUATOR_REFUSAL");
        if (data.stop_reason === "max_tokens") throw new EvaluationError("OUTPUT_TRUNCATED");
        if (data.stop_reason !== "end_turn") throw new EvaluationError("UNEXPECTED_STOP");
        if (!attempt.usage || !attempt.responseModel || !Array.isArray(data.content) || data.content.length !== 1)
          throw new EvaluationError("INVALID_RESPONSE");
        const block: unknown = data.content[0];
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") throw new EvaluationError("INVALID_RESPONSE");
        return parse(block.text);
      });
      attempt.latencyMs = Math.round(performance.now() - attemptStarted);
      return { result, errorCode: null, attempts, retryCount: retry, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      attempt.errorCode = error instanceof EvaluationError ? error.code : "INTERNAL_ERROR";
      attempt.latencyMs = Math.round(performance.now() - attemptStarted);
      if (!transient.has(attempt.errorCode) || retry === REQUEST_POLICY.maxRetries) {
        return { result: null, errorCode: attempt.errorCode, attempts, retryCount: retry, latencyMs: Math.round(performance.now() - started) };
      }
      const delay = Math.max(REQUEST_POLICY.backoffMs[retry] ?? 0, retryAfterMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new EvaluationError("INTERNAL_ERROR"); // The bounded loop always returns.
}
