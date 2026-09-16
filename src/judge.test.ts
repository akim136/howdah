import { afterEach, describe, expect, it, vi } from "vitest";
import { judge, MODELS } from "./judge.js";
import { FAITHFULNESS } from "./rubric.js";
import { CASE, envelope, groundingAbstention, groundingResponse, mockFetch, rubricAbstention, rubricResponse } from "./test-fixtures.js";

afterEach(() => vi.useRealTimers());

function evaluate(responses: unknown[], answer = CASE.answer) {
  const fetchImpl = vi.fn(mockFetch(responses));
  return { fetchImpl, result: judge({ ...CASE, answer }, { apiKey: "synthetic-test-key", rubric: FAITHFULNESS, fetchImpl }) };
}

describe("judge cascade", () => {
  it("settles a clear screen in two calls and retains results and measurements", async () => {
    const { result, fetchImpl } = evaluate([envelope(rubricResponse([5, 5, 1, 1])), envelope(groundingResponse())]);
    const value = await result;
    expect(value).toMatchObject({ outcome: "faithful", model: MODELS.screen, escalated: false, answerQualityScore: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(value.stages).toHaveLength(2);
    expect(value.stages[0]).toMatchObject({ kind: "rubric", result: { status: "evaluated", faithfulnessScore: 5 }, retryCount: 0,
      attempts: [{ usage: { inputTokens: 123, outputTokens: 45 }, responseModel: MODELS.screen, stopReason: "end_turn", errorCode: null }] });
    expect(value.stages[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    const first = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(first.output_config.format.type).toBe("json_schema");
    expect(first.system).toContain("untrusted input");
    expect(JSON.parse(first.messages[0].content)).toEqual({ context: CASE.context, question: CASE.question, answer: CASE.answer });
  });

  it.each([
    [rubricResponse([4, 4, 5, 5]), groundingResponse()],
    [rubricResponse([1, 1, 5, 5]), groundingResponse()],
    [rubricResponse(undefined, ["rubric flag"]), groundingResponse()],
    [rubricResponse(), groundingResponse(["grounding flag"])],
    [rubricAbstention, groundingResponse()],
    [rubricResponse(), groundingAbstention],
  ])("escalates uncertainty or any faithfulness failure and uses the valid stronger result (%#)", async (rubric, grounding) => {
    const { result, fetchImpl } = evaluate([envelope(rubric), envelope(grounding),
      envelope(rubricResponse(), "end_turn", MODELS.escalation), envelope(groundingResponse(), "end_turn", MODELS.escalation)]);
    const value = await result;
    expect(value).toMatchObject({ outcome: "faithful", model: MODELS.escalation, escalated: true, flags: [] });
    expect(value.stages).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(call[1]!.body as string).model)).toEqual([MODELS.screen, MODELS.screen, MODELS.escalation, MODELS.escalation]);
  });

  it("retains flags from both graders in a final unfaithful judgment", async () => {
    const flagged = rubricResponse(undefined, ["contradiction", "misattribution"]);
    const { result } = evaluate([envelope(flagged), envelope(groundingResponse()), envelope(flagged), envelope(groundingResponse(["unsupported A", "unsupported B"]))]);
    expect(await result).toMatchObject({ outcome: "unfaithful", escalated: true, flags: ["contradiction", "misattribution", "unsupported: unsupported A", "unsupported: unsupported B"] });
  });

  it("abstains only on valid ambiguity after escalation", async () => {
    const { result } = evaluate([envelope(rubricAbstention), envelope(groundingAbstention), envelope(rubricAbstention), envelope(groundingResponse())]);
    expect(await result).toMatchObject({ outcome: "abstained", reason: rubricAbstention.reason, errorCode: null, faithfulnessScore: null });
  });

  it("abstains locally on empty answers with no paid calls", async () => {
    const { result, fetchImpl } = evaluate([], " \n ");
    expect(await result).toMatchObject({ outcome: "abstained", reason: "empty answer", stages: [], model: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves length and number signals advisory", async () => {
    const { result } = evaluate([envelope(rubricResponse()), envelope(groundingResponse())], "A total of 636. " + "word ".repeat(251));
    expect((await result).outcome).toBe("faithful");
  });

  it.each([0, 1, 2, 3])("errors on invalid response at stage %i and preserves completed stages", async (badIndex) => {
    const replies = [envelope(rubricResponse([4, 4, 5, 5])), envelope(groundingResponse()), envelope(rubricResponse()), envelope(groundingResponse())];
    replies[badIndex] = envelope("{truncated");
    const { result, fetchImpl } = evaluate(replies);
    const value = await result;
    expect(value).toMatchObject({ outcome: "error", errorCode: "INVALID_JSON", faithfulnessScore: null, escalated: badIndex > 1 });
    expect(value.stages).toHaveLength(badIndex + 1);
    expect(value.stages.at(-1)).toMatchObject({ errorCode: "INVALID_JSON", result: null });
    expect(fetchImpl).toHaveBeenCalledTimes(badIndex + 1);
  });

  it.each(["refusal", "max_tokens", "tool_use"])("does not accept apparently passing JSON when terminated with %s", async (stop) => {
    const { result } = evaluate([envelope(rubricResponse()), envelope(groundingResponse(), stop)]);
    expect((await result).outcome).toBe("error");
  });

  it("does not fall back to a passing screen when Sonnet fails", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(envelope(rubricResponse([4, 4, 5, 5]))))
      .mockResolvedValueOnce(Response.json(envelope(groundingResponse())))
      .mockRejectedValue(new Error("private upstream data"));
    const result = judge(CASE, { apiKey: "synthetic-test-key", rubric: FAITHFULNESS, fetchImpl });
    await vi.runAllTimersAsync();
    const value = await result;
    expect(value).toMatchObject({ outcome: "error", errorCode: "NETWORK_ERROR", escalated: true });
    expect(value.stages).toHaveLength(3);
    expect(value.stages[2]?.retryCount).toBe(2);
    expect(JSON.stringify(value)).not.toContain("private upstream data");
  });
});

describe("single-model strategies", () => {
  it("rejects an invalid strategy at the library boundary before any request", async () => {
    const fetchImpl = vi.fn(mockFetch([]));
    await expect(judge(CASE, { apiKey: "test", rubric: FAITHFULNESS, fetchImpl, strategy: "unknown" as "haiku" })).rejects.toThrow("Unknown judge strategy");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["haiku", "sonnet"] as const)("uses only %s even when its judgment fails or abstains", async (strategy) => {
    const model = strategy === "haiku" ? MODELS.screen : MODELS.escalation;
    for (const rubric of [rubricResponse([1, 1, 5, 5], ["contradiction"]), rubricAbstention]) {
      const fetchImpl = vi.fn(mockFetch([envelope(rubric, "end_turn", model), envelope(groundingResponse(), "end_turn", model)]));
      const result = await judge(CASE, { apiKey: "test", rubric: FAITHFULNESS, fetchImpl, strategy });
      expect(result.outcome).toBe(rubric.status === "abstained" ? "abstained" : "unfaithful");
      expect(result.escalated).toBe(false);
      expect(result.stages.map((s) => s.model)).toEqual([model, model]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls.map((call) => JSON.parse(call[1]!.body as string).model)).toEqual([model, model]);
    }
  });
  it.each(["haiku", "sonnet"] as const)("retains failures without a fallback for %s", async (strategy) => {
    const fetchImpl = vi.fn(mockFetch([envelope("{}"), envelope(groundingResponse())]));
    const result = await judge(CASE, { apiKey: "test", rubric: FAITHFULNESS, fetchImpl, strategy });
    expect(result).toMatchObject({ outcome: "error", escalated: false, errorCode: "INVALID_SCHEMA" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
