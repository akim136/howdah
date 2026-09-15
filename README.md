# howdah

[![CI](https://github.com/akim136/howdah/actions/workflows/ci.yml/badge.svg)](https://github.com/akim136/howdah/actions/workflows/ci.yml)

**A lightweight evaluation harness for answer faithfulness: does an answer stay true to its supplied context?**

A *howdah* is the seat that rides on top of an elephant. This harness sits above model outputs, checking their factual support and comparing its judgments with human labels.

## What it measures

Three layers evaluate each `(context, question, answer)` triple:

1. **Advisory checks** flag empty or long answers and number tokens absent from the context. A matching number can still be misattributed; a new number can be valid arithmetic. These signals never establish fabrication or decide faithfulness.
2. **Rubric grading** scores factual support separately from answer quality. Haiku screens nonempty answers; low, borderline, flagged, or ambiguous judgments escalate to Sonnet.
3. **Grounding grading** independently lists unsupported factual claims. Both graders must complete successfully for a classification.

### Verdict contract (`faithfulness-v2`)

| Outcome | Meaning |
|---|---|
| `faithful` | Weighted factual-support score is at least 4.0 and both graders have zero faithfulness flags. |
| `unfaithful` | Valid grading fails the factual-support threshold or identifies an unsupported claim or other faithfulness disqualifier. |
| `abstained` | A valid grader response reports ambiguity or insufficient evidence to judge; also used for an empty candidate answer, with an explicit reason. |
| `error` | A request failed, the evaluator refused, output was truncated, or the response failed validation. |
| `skipped` | Checks-only mode; no model classification was attempted. |

The factual score uses `supported_by_context` at **4/7** and `no_fabrication` at **3/7**, preserving the original ratio. The initial threshold of **4.0 is uncalibrated**. Completeness and appropriate refusal are reported as individual quality dimensions and an equally weighted quality score; they do not enter the factual score or trigger escalation. Scores are not rounded before decisions.

A candidate's correct refusal can be faithful. An API evaluator refusal is an **error**. Merely lacking an answer in the context does not force abstention: a judge can still detect whether the candidate acknowledges the gap or invents an answer.

Haiku escalates when the factual score is below **4.5**, either grader flags faithfulness, or either grader abstains. A valid Sonnet result supplies the final judgment, even when it disagrees with Haiku. A failed escalation produces an error. Earlier results remain in the artifacts. The cascade uses two calls per normally completed screen, or four when escalated; errors stop that case's remaining stages. Empty answers make no calls.

## Run it

Use **Node 24 LTS** (`nvm use` reads `.nvmrc`) and npm. There are no production dependencies.

```bash
npm ci

# Free: advisory checks; every classification is explicitly skipped.
npm run eval -- --checks-only --output-dir /tmp/howdah-checks

# Full evaluation makes paid Anthropic API calls.
cp .env.example .env       # set ANTHROPIC_API_KEY
npm run eval -- --dataset data/cases.json --output-dir /tmp/howdah-full

# Suppress per-case progress and the report on stdout; retain a summary on stderr.
npm run eval -- --checks-only --quiet --output-dir /tmp/howdah-checks

npm test
npm run typecheck
```

Full mode requires `ANTHROPIC_API_KEY` in the environment or `.env`. Missing/blank credentials and the example placeholder fail clearly; they never switch modes. Explicit environment values take precedence over `.env`. Checks-only mode does not read `.env`.

Options: `--dataset PATH`, `--output-dir PATH`, `--checks-only`, `--quiet`. Defaults are `data/cases.json` and the repository root. Each run replaces `results.json` and `report.md` in its output directory; use distinct directories to preserve runs. The default artifact names are gitignored.

Exit status is **1** for invalid configuration/data, output failures, or any evaluation error. Evaluation errors retain every case and all completed stages in the written artifacts. Abstentions and poor classification performance return **0**: inspect coverage and metrics before drawing conclusions. A process interruption is not a completed run; artifacts are written after all cases finish.

## Input and output

A dataset is a nonempty JSON array. Each row requires a unique nonempty `id`, string `context`, `question`, and `answer`, and a `label` of `faithful` or `unfaithful`. Optional `note` must be a string. Empty answers and contexts are allowed. The entire dataset is validated before requests begin. Labels, IDs, notes, and extra annotation fields never enter evaluator prompts.

Use **public or synthetic data**. Artifacts contain validated evaluator evidence, which can quote input. The runner does not record raw input rows, request payloads, credentials, upstream error bodies, or exception messages from requests.

`results.json` uses **schemaVersion `2.0`** and includes:

- Every case's outcome, advisory checks, final scores, reason, and flags.
- Every attempted rubric/grounding stage, including superseded results and errors.
- Requested and returned model identifiers, token usage, per-attempt latency and sanitized error codes, retries, and stage latency including backoff. Unavailable usage is `null`, not zero.
- Code revision and dirty-worktree status, dataset SHA-256 over the exact file bytes, timestamps, rubric configuration/version, and model/request configuration.
- Confusion counts, classification metrics, coverage, abstentions, errors, skipped cases, and measured usage totals.

`report.md` presents the same findings, with full stage evidence and escaped table content. **Coverage is classified cases / all cases.** Accuracy, precision, recall, and F1 are conditional on classified cases; `unfaithful` is the positive class. Undefined metrics are `null` in JSON and `n/a` in Markdown. F1 is `2TP / (2TP + FP + FN)`, so false positives/negatives with zero true positives yield zero. Escalation rate uses cases with at least one API attempt, including eventual errors.

### Request behavior

The judge retains native `fetch`, using `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`. Requests use [Anthropic structured JSON outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and strict local validation. Missing or duplicate dimensions, non-integer/out-of-range scores, missing evidence, malformed flags, and inconsistent abstentions are errors. Only `end_turn` completions are accepted.

Each attempt has a **60-second timeout covering headers and body**, with **at most two retries** for network failures, timeouts, HTTP 429, and server errors. Backoff is 500 ms then 1,000 ms; `Retry-After` can extend either delay to at most 5 seconds. Authentication, schema, parsing, and termination errors are not retried. A call allows 1,600 output tokens. Retries can incur additional usage; unknown usage is reported explicitly.

Evaluator instructions use the system message; serialized input uses the user message. Prompts treat input as untrusted data. This separation and schema validation do **not** prove resistance to prompt injection or guarantee correct judgments.

## Evidence and limitations

`data/cases.json` remains the original **18-case hand-authored synthetic smoke suite**, with deliberately clear-cut examples. It demonstrates the harness's mechanics; it does not establish accuracy on real inputs. [The historical sample report](sample-report.md) preserves the June 2026 output and identifies its original, incompatible v1 methodology. Its published 100% is not evidence for the current rubric.

Tests exercise parsing, verdict construction, cascade decisions, transport failures, metrics, input validation, and the actual CLI with a mocked API. They make no paid calls and do not establish judge accuracy. CI runs these checks and a checks-only smoke run on Node 24.

Next work is separate: add realistic development/held-out examples split by source or scenario, calibrate graders, compare single-model baselines with the cascade, and report repeated-trial uncertainty, usage, latency, and reviewed failures. Recorded agent traces and a synthetic support environment follow that work. The current harness evaluates completed answers; it does not verify tool actions or task completion.

## Code map

| File | Responsibility |
|---|---|
| `src/types.ts`, `src/validation.ts` | Result contract and strict input validation |
| `src/checks.ts` | Advisory deterministic checks |
| `src/rubric.ts`, `src/grounding.ts` | Prompts, output schemas, parsers, factual and quality scoring |
| `src/transport.ts`, `src/judge.ts` | Bounded API requests and cascade orchestration |
| `src/reporting.ts`, `src/run.ts` | Metrics, artifacts, and CLI |

V2 changes the boolean verdict and score format. Consumers must migrate to explicit outcomes and separate scores. Preserve old reports by format/methodology version; reverting the code requires no data migration or deployment.

## Built with

Claude Code, used as a pair-programmer. The problem framing, the three-layer architecture, the faithfulness rubric, the dataset, and the methodology decisions are mine; the agent accelerated the implementation. The commit history is co-authored accordingly — I think that's the honest way to ship in 2026, and knowing how to drive an agent to a clean, tested, measurable result is part of the point.

## License

MIT.
