#!/usr/bin/env bash
set -euo pipefail

# The main website is static and has no dependency installation or migration.
# Browser checks run separately, once the application workflow is serving.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node tests/verify-interface.mjs
node --test tests/*.test.cjs