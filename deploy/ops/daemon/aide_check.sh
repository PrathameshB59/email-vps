#!/usr/bin/env bash
set -euo pipefail

if command -v aide >/dev/null 2>&1; then
  exec aide --check
fi

if command -v aide.wrapper >/dev/null 2>&1; then
  exec aide.wrapper --check
fi

echo "[aide-check] AIDE binary not found (expected 'aide' or 'aide.wrapper')." >&2
exit 127

