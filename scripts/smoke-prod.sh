#!/usr/bin/env bash
# Prod smoke runner — read-only checks against the live stride-app deploy.
# Usage:
#   ./scripts/smoke-prod.sh                # run all 7 cases, terminal output
#   ./scripts/smoke-prod.sh -k weeks       # filter by name
#   ./scripts/smoke-prod.sh --e2e-config=tests/e2e/e2e.config.staging.json
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="out"
mkdir -p "$OUT_DIR"
HTML_REPORT="$OUT_DIR/e2e-report.html"

# pytest-html is optional. If installed we also emit an HTML report; if not
# we still run the suite and print to stdout only.
HTML_ARGS=()
if python -c "import pytest_html" 2>/dev/null; then
    HTML_ARGS=(--html="$HTML_REPORT" --self-contained-html)
else
    echo "(pytest-html not installed — terminal-only output. Install with: pip install pytest-html)"
fi

exec pytest tests/e2e -m e2e -v "${HTML_ARGS[@]}" "$@"
