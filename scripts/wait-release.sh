#!/usr/bin/env bash
# Wait for the GitHub Actions release workflow to complete for a given tag.
# Usage: ./scripts/wait-release.sh v0.2.0 [--max-wait <seconds>]
# Polls every 5 seconds, exits 0 on success, 1 on workflow failure, 2 on timeout.
# A failed GitHub CLI (gh) query passes its exit code through.

set -euo pipefail

TAG=""
MAX_WAIT="${MAX_WAIT_SECONDS:-900}"
REPO="cortexkit/openai-auth"
INTERVAL=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-wait)
      MAX_WAIT="${2:-}"
      if [[ $# -lt 2 ]]; then
        echo "--max-wait requires a number of seconds" >&2
        exit 64
      fi
      shift 2
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 64
      ;;
    *)
      if [[ -z "$TAG" ]]; then
        TAG="$1"
      else
        echo "Unexpected positional argument: $1" >&2
        exit 64
      fi
      shift
      ;;
  esac
done

if [[ -z "$TAG" || ! "$MAX_WAIT" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "Usage: wait-release.sh <tag> [--max-wait <seconds>]" >&2
  exit 64
fi

echo "⏳ Waiting for release workflow on ${TAG} (max ${MAX_WAIT}s)..."

START_TIME=$(date +%s)

timeout() {
  echo "⏱  Timed out after ${MAX_WAIT}s waiting for workflow to complete."
  echo "   Check: https://github.com/${REPO}/actions"
  exit 2
}

query_run() {
  node --input-type=module - "$1" "$REPO" "$TAG" <<'NODE'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'

const [remaining, repo, tag] = process.argv.slice(2)
const result = spawnSync('gh', [
  'run', 'list', '--repo', repo, '--workflow', 'release.yaml', '--branch', tag,
  '--limit', '1', '--json', 'status,conclusion,databaseId',
], { stdio: ['ignore', 'pipe', 'inherit'], timeout: Number(remaining) * 1000, killSignal: 'SIGKILL' })
if (result.error) {
  console.error(`Release query failed: ${result.error.message}`)
  process.exitCode = result.error.code === 'ETIMEDOUT' ? 2 : 1
} else if (result.status !== 0) {
  console.error(`Release query failed: gh exited with ${result.status ?? result.signal}`)
  process.exitCode = result.signal ? 128 + constants.signals[result.signal] : result.status
} else {
  process.stdout.write(result.stdout)
}
NODE
}

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))
  REMAINING=$((MAX_WAIT - ELAPSED))
  if (( REMAINING <= 0 )); then timeout; fi

  RUN_JSON=$(query_run "$REMAINING") || exit $?

  STATUS=$(printf '%s\n' "$RUN_JSON" | jq -er '
    if type != "array" then error("expected an array of workflow runs")
    elif length == 0 then "not_found"
    elif (.[0].status | type) == "string" then .[0].status
    else error("workflow run has no status") end
  ')
  CONCLUSION=$(echo "$RUN_JSON" | jq -r '.[0].conclusion // ""')
  RUN_ID=$(echo "$RUN_JSON" | jq -r '.[0].databaseId // ""')

  if [ "$STATUS" = "not_found" ]; then
    echo "  [+${ELAPSED}s] Workflow not started yet..."
  elif [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      echo "✅ Release workflow succeeded (run ${RUN_ID})"
      echo "   https://github.com/${REPO}/actions/runs/${RUN_ID}"
      exit 0
    else
      echo "❌ Release workflow failed: conclusion=${CONCLUSION} (run ${RUN_ID})"
      echo "   https://github.com/${REPO}/actions/runs/${RUN_ID}"
      exit 1
    fi
  else
    echo "  [+${ELAPSED}s] Status: ${STATUS} (run ${RUN_ID})"
  fi
  REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
  if (( REMAINING <= 0 )); then timeout; fi
  sleep "$((REMAINING < INTERVAL ? REMAINING : INTERVAL))"
done
