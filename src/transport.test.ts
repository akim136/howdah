import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUNDING_SCHEMA, parseGrounding } from "./grounding.js";
import { requestJson, REQUEST_POLICY } from "./transport.js";
import { envelope, groundingResponse } from "./test-fixtures.js";

const model = "claude-haiku-4-5-20251001";
const prompt = { system: "Instructions", data: "Synthetic input" };
const request = (fetchImpl: typeof fetch) => requestJson(model, prompt, GROUNDING_SCHEMA, parseGrounding, { apiKey: "private-test-key", fetchImpl });
const success = () => Response.json(envelope(groundingResponse()));
afterEach(() => vi.useRealTimers());

describe("bounded transport", () => {
  it("keeps authentication in headers and uses structured output", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const result = await request(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({ "x-api-key": "private-test-key" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model, system: prompt.system, messages: [{ role: "user", content: prompt.data }], output_config: { format: { type: "json_schema", schema: GROUNDING_SCHEMA } } });
    expect(JSON.stringify(result)).not.toContain("private-test-key");
    expect(JSON.stringify(result)).not.toContain("Synthetic input");
  });

  it.each([429, 500, 503, 529])("retries transient HTTP %i twice, discarding bodies", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("private-upstream-body", { status }));
    const pending = request(fetchImpl);
    await vi.runAllTimersAsync();
    const value = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(value.retryCount).toBe(2);
    expect(value.errorCode).toBe(status === 429 ? "RATE_LIMIT" : "SERVER_ERROR");
    expect(value.attempts.map((a) => a.httpStatus)).toEqual([status, status, status]);
    expect(JSON.stringify(value)).not.toContain("private-upstream-body");
  });

  it("bounds Retry-After and preserves earlier failed attempts on success", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("secret", { status: 429, headers: { "retry-after": "999999" } }))
      .mockResolvedValueOnce(success());
    const pending = request(fetchImpl);
    await vi.advanceTimersByTimeAsync(REQUEST_POLICY.maxBackoffMs - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const value = await pending;
    expect(value).toMatchObject({ retryCount: 1, errorCode: null, result: { status: "evaluated" } });
    expect(value.attempts[0]?.errorCode).toBe("RATE_LIMIT");
    expect(value.attempts[1]?.usage).toMatchObject({ inputTokens: 123, outputTokens: 45 });
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %i or expose raw error text", async (status) => {
    const body = { cancel: vi.fn().mockResolvedValue(undefined) };
    const text = vi.fn().mockRejectedValue(new Error("must not read body"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({ ok: false, status, headers: new Headers(), body, text } as unknown as Response);
    const result = await request(fetchImpl);
    expect(result.retryCount).toBe(0);
    expect(result.errorCode).toBe([401, 403].includes(status) ? "AUTH_ERROR" : "HTTP_ERROR");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("retries network failures with bounded backoff and sanitizes thrown messages", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("credentials and private payload"));
    const pending = request(fetchImpl);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ errorCode: "NETWORK_ERROR", retryCount: 2 });
    expect(JSON.stringify(await pending)).not.toContain("credentials and private payload");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(["headers", "body"])("times out hanging %s after 60 seconds per attempt", async (part) => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signals.push(init!.signal!);
      if (part === "headers") return new Promise<Response>(() => {});
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response;
    });
    const pending = request(fetchImpl);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ errorCode: "REQUEST_TIMEOUT", retryCount: 2 });
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it.each([
    ["refusal", "EVALUATOR_REFUSAL"], ["max_tokens", "OUTPUT_TRUNCATED"], ["tool_use", "UNEXPECTED_STOP"], [null, "UNEXPECTED_STOP"],
  ])("rejects termination %s even with valid JSON", async (stop, code) => {
    const data = { ...envelope(groundingResponse()), stop_reason: stop };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
    const result = await request(fetchImpl);
    expect(result).toMatchObject({ errorCode: code, retryCount: 0, result: null });
    expect(result.attempts[0]?.usage?.outputTokens).toBe(45);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    null, {}, { ...envelope(groundingResponse()), content: [] },
    { ...envelope(groundingResponse()), content: [{ type: "tool_use", text: "{}" }] },
    { ...envelope(groundingResponse()), content: [{ type: "text", text: 1 }] },
    { ...envelope(groundingResponse()), content: [...envelope(groundingResponse()).content, ...envelope(groundingResponse()).content] },
    { ...envelope(groundingResponse()), usage: undefined },
    { ...envelope(groundingResponse()), usage: { input_tokens: -1, output_tokens: 0 } },
    { ...envelope(groundingResponse()), usage: { input_tokens: "123", output_tokens: 0 } },
    { ...envelope(groundingResponse()), usage: { input_tokens: 123, output_tokens: 0, cache_creation_input_tokens: null } },
    { ...envelope(groundingResponse()), model: "untrusted upstream message" },
  ])("rejects malformed envelopes without retrying (%#)", async (data) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
    const result = await request(fetchImpl);
    expect(result.result).toBeNull();
    expect(result.errorCode).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["garbage", "{}"])("rejects invalid evaluator JSON/schema without retries: %s", async (raw) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope(raw)));
    expect((await request(fetchImpl)).errorCode).toBe(raw === "garbage" ? "INVALID_JSON" : "INVALID_SCHEMA");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry invalid HTTP response JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private malformed body", { status: 200 }));
    expect((await request(fetchImpl)).errorCode).toBe("INVALID_RESPONSE");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
