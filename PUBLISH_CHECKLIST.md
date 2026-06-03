# Pre-publish checklist

This repo is created **private**. Run through this before flipping it to public on GitHub.

- [ ] `bash scripts/scan-clean.sh` exits clean (no PII / secret / private-project hits).
- [ ] `.env` is **not** tracked (`git ls-files | grep .env` shows only `.env.example`).
- [ ] `.env.example` contains a **placeholder** key only — no real `ANTHROPIC_API_KEY`.
- [ ] `data/cases.json` is entirely synthetic/public-domain — no real people, employers, or private context.
- [ ] `README.md` and code contain no reference to the private job-search platform or its data.
- [ ] `npm test` passes and `npm run eval -- --checks-only` runs without a key.
- [ ] (Optional) a full `npm run eval` produced a `report.md` you're happy to showcase. **`report.md` is gitignored** — commit a curated copy under another name (e.g. `sample-report.md`) if you want it in the repo.

Then: `gh repo edit --visibility public` (or via the GitHub UI). Until then it stays private.
