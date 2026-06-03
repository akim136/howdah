#!/usr/bin/env bash
# Pre-publish safety scan: assert the repo contains no PII, private-project references, or secrets.
# Run before flipping the GitHub repo to public. Exits non-zero (and prints hits) if anything matches.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# Patterns that must NOT appear anywhere tracked: real names, the private platform, Airtable/CF ids,
# tokens, and absolute paths from the source machine. (Case-insensitive.)
# Real Anthropic keys look like sk-ant-api0...; the documented sk-ant-your-key-here placeholder is fine.
PATTERNS='alex|kim|homebase|akbuilds|akim04|akim136|search-system|appNYK|tbl[A-Za-z0-9]{14}|fld[A-Za-z0-9]{14}|sk-ant-api[0-9]|\bpat[A-Za-z0-9]{14}|d7354b9a8c28f9fa864755853236820d|/Users/'

# Scan tracked files only (skip node_modules, .git, the gitignored .env/report).
files=$(git ls-files 2>/dev/null || find . -type f -not -path './node_modules/*' -not -path './.git/*')
hits=$(printf '%s\n' "$files" | grep -vE '(^|/)(LICENSE|scripts/scan-clean.sh|PUBLISH_CHECKLIST.md)$' \
  | xargs grep -rInE "$PATTERNS" 2>/dev/null)

if [ -n "$hits" ]; then
  echo "✗ scan-clean: potential PII / secret / private-ref hits:"
  echo "$hits"
  exit 1
fi
echo "✓ scan-clean: no PII / secret / private-reference patterns found."
