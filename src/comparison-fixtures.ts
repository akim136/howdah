import { check } from "./checks.js";
import { ESCALATE_BUFFER, MODELS } from "./judge.js";
import { createRun } from "./reporting.js";
import { FAITHFULNESS } from "./rubric.js";
import { CASE } from "./test-fixtures.js";
import { MAX_TOKENS, REQUEST_POLICY } from "./transport.js";
import type { Outcome, Row, Strategy } from "./types.js";

export const outcomeRow = (outcome: Outcome, id = "a", gold: Row["gold"] = "faithful"): Row => ({ id, gold, outcome, checks: check(CASE), evaluation: null });
export const trialRun = (strategy: Strategy, trial: number, rows: Row[] = [outcomeRow("faithful")]) => ({ strategy, trial,
  run: createRun({ strategy, trial, startedAt: "2026-09-16T12:00:00.000Z", completedAt: "2026-09-16T12:00:01.000Z",
    mode: "full", codeRevision: "test-revision", workingTreeDirty: false, dataset: { file: "synthetic.json", sha256: "test-dataset" }, rubric: FAITHFULNESS,
    modelConfiguration: { ...MODELS, escalationBuffer: ESCALATE_BUFFER, maxTokens: MAX_TOKENS, requestPolicy: REQUEST_POLICY } }, rows) });
