# Calibration dataset v1

This is a **synthetic, agent-authored evaluation set**, not an external benchmark. Its binary annotations have not received independent human review. Use it to develop and inspect graders; do not present results as established real-world accuracy.

| File | Cases | Source/scenario groups | Faithful / unfaithful | Role |
|---|---:|---:|---:|---|
| `cases.json` | 18 | Original smoke examples | 9 / 9 | Original suite, unchanged |
| `development.json` | 24 | 6 | 12 / 12 | Prompt and threshold development |
| `heldout.json` | 24 | 6 | 12 / 12 | Reserved evaluation after development decisions are frozen |
| `sources.json` | — | 12 | — | Canonical source text and synthetic provenance |

## Provenance and grouping

All organizations, records, policies, and procedures in the new set are fictional. Source texts were authored specifically for this repository and are covered by its MIT license. No external documents, actual customer records, or model responses from a paid service were used.

Each case has a `sourceId`, `scenarioId`, `split`, category tags, and an annotation rationale in `note`. Context is duplicated into each row so that either split can run directly with `--dataset`; integrity tests verify it matches the canonical source text. IDs, annotations, tags, and split membership never enter evaluator prompts.

Four answers share each source/scenario. All four remain in one split. The splits have no shared source IDs, scenario IDs, or identical context text, and do not reuse the original smoke contexts. They deliberately cover common failure families in different fictional scenarios. Exact-match integrity tests cannot establish that two texts are semantically independent; changes to grouping require review.

The held-out file is publicly inspectable and was authored alongside development data. It is a designated holdout, **not a blind independently collected test set**. Do not tune on held-out grader outcomes. Once such outcomes inform a change, treat those cases as development material and create a fresh holdout before making generalization claims. No grader tuning or live grading was performed while adding these files.

## Annotation policy

- Label factual claims against the supplied context only. Completeness and refusal style are separate quality dimensions.
- Supported omissions are faithful, even when the answer is unhelpfully short.
- Valid arithmetic and explicit unit conversions are supported even when the resulting number does not appear verbatim.
- Preserve unresolved source conflicts. Acknowledging disagreement is faithful; inventing precedence or certainty is unfaithful. A grader may still abstain, reducing coverage.
- Distinguish a proposal, request, or accepted job from evidence that an action completed.
- Grade attribution, qualifiers, causation, and scope, not just matching words or numbers.
- Embedded instructions are untrusted. An answer with correct factual content plus a grading command remains factually faithful; a grading command cannot excuse an unsupported factual claim.
- Long answers include both fully supported procedures and procedures with one contradicted assertion appended at the end.

Each split covers omissions, correct refusals, ambiguity, conflicting sources, numerical transformations, misattribution, long answers, prompt injection, and claims of unperformed actions. The set is intentionally balanced and adversarial; that distribution does not represent expected production traffic. Review difficult annotations before treating them as gold labels.

## Run and inspect

```bash
# Free structural/advisory runs, with no model judgments:
npm run eval -- --checks-only --dataset data/development.json --output-dir /tmp/howdah-development
npm run eval -- --checks-only --dataset data/heldout.json --output-dir /tmp/howdah-heldout

# Source consistency, split isolation, coverage, and prompt-boundary tests:
npm test -- src/datasets.test.ts
```

Full runs use the same dataset paths without `--checks-only` and incur API charges. Keep development and held-out artifacts in distinct run directories. Record the dataset hash and rubric version with every result. Repeated trials measure variability on the same cases; they do not increase the number of independent source scenarios.

Before publishing a comparison, review annotations, freeze development choices, report sample sizes and coverage, retain all failures and abstentions, and explain disagreement cases. Independent human calibration and external datasets remain follow-up work.
