#!/usr/bin/env bash
set -euo pipefail

# app.js hands us the decoded JIT config from /run. Good for one job, then it's dead.
exec /home/runner/actions-runner/run.sh --jitconfig "$ENCODED_JIT_CONFIG"
