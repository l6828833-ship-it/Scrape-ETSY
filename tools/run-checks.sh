#!/usr/bin/env bash
# Run every check in order. Requires Node 22+ (built-in WebSocket) and, for the
# browser-backed checks, a Chrome/Chromium binary (set CHROME_PATH to override).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== 1/4 parser, settings, scheduler and export unit checks =="
node tests/verify.mjs

echo
echo "== 2/4 XLSX workbook validation (Python stdlib) =="
python3 tools/check-xlsx.py

echo
echo "== 3/4 DOM parser in headless Chrome =="
node tests/dom-check.mjs

echo
echo "== 4/4 extension load, messaging and run loop in headless Chrome =="
node tests/extension-check.mjs

echo
echo "All checks passed."
