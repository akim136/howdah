# Comparing graders and repeated trials

The comparison command grades the **same completed answers** with Haiku-only, Sonnet-only, and the Haiku-to-Sonnet cascade. A trial repeats grading; it does not generate a new answer or run an agent. It uses the current rubric and threshold unchanged.

## Commands

```bash
# Free verification of the complete comparison/reporting pipeline:
npm run compare -- --checks-only --trials 2 --dataset data/cases.json --output-dir /tmp/howdah-comparisons

# Paid grading; requires ANTHROPIC_API_KEY. Run only with an intentional API budget:
npm run compare -- --trials 3 --dataset data/cases.json --output-dir /tmp/howdah-comparisons --pricing pricing/anthropic-standard.json

# Compare a subset, or run one baseline through the existing eval command:
npm run compare -- --checks-only --strategies haiku,sonnet --trials 2
npm run eval -- --checks-only --strategy sonnet
```

Once the dataset follow-up is merged, substitute `data/development.json` for development and `data/heldout.json` for frozen evaluation. Run them separately. Do not tune a grader on held-out outcomes.

| Option | Default | Meaning |
|---|---|---|
| `--dataset PATH` | `data/cases.json` | Validated once and reused for all strategies/trials |
| `--output-dir PATH` | `comparisons/` | Parent of a new unique comparison directory |
| `--strategies LIST` | `haiku,sonnet,cascade` | Unique comma-separated subset |
| `--trials N` | `3` | Integer from 1 to 20 per strategy |
| `--pricing PATH` | None | Explicit per-million-token USD rates; otherwise cost is not estimated |
| `--checks-only` | Off | No credentials loaded or API requests; all cases skipped |
| `--quiet` | Off | Suppress progress and Markdown on stdout; retain completion/error summary on stderr |

Each single-model strategy runs rubric and grounding with only that model. It can classify, abstain, or error; it never falls back or reports an escalation. The default `eval` strategy remains `cascade`.

Calls run sequentially. Strategy order rotates each trial to avoid always running the same model first; the actual order is recorded. All models receive the same context, question, and answer fields with the same evaluator instructions and schemas. Annotations remain excluded. The source file is read only once, so edits made during the comparison cannot change later trial inputs.

The CLI prints a conservative maximum API-attempt count before full execution. With all strategies, `N` nonempty cases and `T` trials, the upper bound is `N × T × (2 + 2 + 4) × 3`, including two retries per stage. Actual calls can be fewer. Trial count is bounded, but this is **not a dollar spending cap**. Cost is measured after requests. No paid runs were used to validate this implementation.

## Artifacts and failures

Every invocation creates a unique directory under the output parent. For example:

```text
comparison-abc123/
  manifest.json
  comparison.json
  comparison.md
  haiku-trial-001/
    results.json
    report.md
  sonnet-trial-001/...
  cascade-trial-001/...
```

Per-trial files retain the schema 2.0 case and stage records, with additive `strategy` and `trial` metadata. The summary uses `comparison-v1`; the manifest uses `comparison-manifest-v1`. The manifest lists every artifact path and SHA-256 hash. Comparison metadata includes dataset hash, rubric/model configuration, code revision, execution order, and the complete supplied pricing snapshot.

Work is written into a hidden `.comparison-*` staging directory. Completed trials are recorded in a running manifest immediately. Only after every planned trial and the summary have been written does a directory rename publish the complete bundle. Concurrent invocations sharing a parent get different directories, and the command never reuses a previous comparison's files.

Evaluation errors do not abort later cases or trials: they stay in the artifacts, and the completed comparison exits **1** if any occurred. Poor accuracy and valid abstentions exit **0**. Invalid options, datasets, or pricing are rejected before requests. An artifact-write failure stops further paid requests, marks the staging manifest failed when possible, preserves completed trial files, and exits **1** with the recovery directory. A hard interruption can leave a running manifest; only bundles with a complete manifest in a published `comparison-*` directory represent completed comparisons. There is no automatic resume or deletion of partial bundles.

The original single-run `eval --output-dir` still replaces its two named output files. Use `compare` for isolated trial bundles, including `--strategies cascade --trials 1` when isolation is needed for a single run.

## Reading the comparison

- **Classification:** accuracy, precision, recall, F1, and confusion counts use classified cases only. Coverage uses all repeated evaluations; errors, abstentions, and skips remain counted separately.
- **Sample size:** the report gives distinct input-case count and trials per strategy. Repeated judgments of a case are correlated and do not increase the number of independent cases or source scenarios.
- **Variability:** per-trial metrics and their observed minimum/maximum show variation. These ranges are not confidence intervals. Undefined metrics stay `null`/`n/a`, with the count of defined trials reported.
- **Repeatability:** compare every pair of valid outcomes for each case across trials. Valid outcomes include abstention; errors and skips do not earn agreement credit. Report both outcome agreement and eligible-pair coverage alongside classification coverage. Consistently abstaining is not evidence of useful classification. One trial has no agreement estimate.
- **Usage:** all recorded attempts count, including retries and failed responses with usage. Missing usage is explicitly unknown.
- **Latency:** sum serial stage latency, including backoff, for each case with API attempts. Report total and nearest-rank p50/p95. Local empty-answer abstentions and checks-only rows have no API latency measurement.
- **Failures:** every case and stage remains in its trial directory. Review false positives/negatives, disagreements, and abstentions rather than selecting a winner from F1 alone.

## Cost estimates

The supplied example records published standard Claude API rates for the two configured models, as checked on 2026-09-16 against [Anthropic's pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing). These rates are an explicit snapshot, not an automatically updated quote. Review them before a paid comparison.

Rates are USD per million tokens keyed by the **requested model ID**:

```json
{
  "currency": "USD",
  "asOf": "2026-09-16",
  "source": "https://platform.claude.com/docs/en/about-claude/pricing",
  "rates": {
    "claude-haiku-4-5-20251001": {
      "input": 1,
      "output": 5,
      "cacheRead": 0.1,
      "cacheCreation": null
    }
  }
}
```

Input/output rates must be nonnegative finite numbers. Cache rates can be numbers or explicit `null`. The example leaves cache creation unknown because the aggregate usage field does not distinguish cache lifetime; assigning a five-minute rate to a one-hour write would understate cost. Current requests do not request prompt caching. If cache creation is reported, the example produces an incomplete estimate. Supply an applicable cache-write rate only when its lifetime is known.

`knownUsd` is a subtotal of components with both measured usage and an applicable rate. `complete` is false if pricing was omitted, usage is missing, or any needed rate is unavailable. A partial subtotal is not a total or a guarantee of spend. Estimates do not account for negotiated rates, regional premiums, discounts, service-tier differences, taxes, or unreported billed work.

## Validation and rollout

Mocked API and subprocess tests cover strategy isolation, fair input alignment, repeated outcomes, all-error runs, pricing gaps, CLI exit codes, artifact hashes, concurrent output isolation, and failed publication. They do not establish model accuracy or live API compatibility. A small live compatibility run, independent annotation review, and budgeted development/held-out calibration remain separate actions.

No production dependencies, migrations, or deployment are introduced. Reverting the comparison command and strategy additions restores the original default cascade CLI; retain existing report versions when comparing historical results.
