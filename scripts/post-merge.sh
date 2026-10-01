#!/usr/bin/env bash
set -euo pipefail
# Development-only setup. Publishing manages the production schema separately.
# Browser checks run through their isolated fixture server.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm ci --no-audit --no-fund
node scripts/apply-dev-schema.cjs
npm test
