# howdah

**An eval harness for RAG / agent answer faithfulness — does the answer stay true to its context, or does it hallucinate?**

A *howdah* is the seat that rides on top of an elephant. This is the seat that rides on top of your LLM: a lightweight judge that sits above model outputs and checks them, rather than trusting them.

It scores each `(context, question, answer)` triple on **faithfulness** and flags any claim the context doesn't support — then reports how well it does against **gold labels**, so the eval itself is measurable rather than vibes.

## Why this design

Three layers, cheap-to-expensive, so most of the work is free or cheap:

1. **Deterministic checks** (`src/checks.ts`) — no API key, instant. Catches empty/over-long answers and a genuinely useful fabrication heuristic: **numbers asserted in the answer that never appear in the context** (a common, machine-detectable hallucination).
2. **LLM-as-judge with a Haiku→Sonnet cascade** (`src/judge.ts`, `src/rubric.ts`) — Haiku scores every answer on a weighted faithfulness rubric (`supported_by_context`, `no_fabrication`, `completeness`, `appropriate_refusal`); only **borderline or flagged** answers escalate to Sonnet for a rigorous second opinion. You pay for the strong model only on the hard calls.
3. **No-fabrication grounding check** (`src/grounding.ts`) — independently lists every claim, number, or entity in the answer that the context doesn't support. **Any grounding flag fails the case**, regardless of the rubric score.

An answer is judged **faithful** only if it clears the score threshold *and* has zero grounding flags.

## Results

`src/run.ts` runs all three layers over a small **gold-labeled** dataset (`data/cases.json`: faithful answers, planted fabrications, over-claims, scale errors, and "the context doesn't say → should refuse" cases) and reports **hallucination-detection precision / recall / F1** against the labels, plus the Haiku→Sonnet escalation rate. Sample output lands in `report.md`.

Treating *"unfaithful"* as the positive class makes the harness's own accuracy a number you can cite — which is the point: an eval you can't evaluate isn't an eval.

## Run it

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY

# Full run: deterministic checks + LLM judge + grounding, scored vs gold labels → report.md
npm run eval

# Free, no API key: deterministic layer only (still catches number fabrications)
npm run eval -- --checks-only

npm test                    # unit tests for the deterministic + parsing layers
```

Set `ANTHROPIC_API_KEY` in `.env` (gitignored) or the environment. The judge uses `claude-haiku-4-5` and escalates to `claude-sonnet-4-6`.

## Extending

Drop your own `(context, question, answer, label)` rows into `data/cases.json` to benchmark a different domain, or point the judge at your RAG pipeline's real outputs. The rubric and grounding prompts live in `src/rubric.ts` and `src/grounding.ts`.

## License

MIT.
