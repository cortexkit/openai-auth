#!/usr/bin/env bash
# Local validation from .github/workflows/ci.yml; release.yaml steps are listed below.
# CI Linux check: checkout, mise (mise.toml), bun install --frozen-lockfile,
# npm ci --ignore-scripts for both host fixtures, bun run types, bun run build,
# bun run test (core, opencode, pi), bun run format:check, bun run lint.
# CI Linux e2e (each): checkout, Node 24, mise, frozen install, both fixture
# installs, build, then in packages/opencode:
#   OPENAI_AUTH_OPENCODE1_E2E=1 bun test src/tests/opencode1-e2e.test.ts
#   OPENAI_AUTH_OPENCODE2_E2E=1 bun test src/tests/opencode2-e2e.test.ts
# The fast phase moves format/lint and packaging ahead of the full suites;
# full shares one install/build and runs the independent package scripts in parallel.
# CI only (Windows: windows-latest and windows-2022): checkout, mise,
# bun install --frozen-lockfile, then in packages/opencode:
#   bun test src/tests/runtime-layout.test.ts
# CI only (release): checkout selected ref, record git rev-parse HEAD, poll
# gh api for successful main-push CI on that SHA (GH_TOKEN, RELEASE_SHA).
# For opencode/pi: Node 24/npm registry, Bun 1.3.14, frozen install, strip v
# from RAW_VERSION and validate semver, node scripts/version-sync.mjs "$VERSION",
# bun run build, npm view "$PACKAGE@$VERSION" version; if not already published:
# npm publish --workspace "$WORKSPACE" --access public --provenance.
# Finally create the GitHub release with generated notes on tag-push runs only.
# Release actions use FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step=usage
logs=
finish() {
  local status=$?
  trap - EXIT
  if [[ -n "$logs" ]]; then rm -rf "$logs"; fi
  if [[ $status -eq 0 ]]; then
    printf 'GATE_OK %s\n' "$(git rev-parse HEAD)"
  else
    printf 'GATE_FAILED %s\n' "$step"
  fi
  exit "$status"
}
trap finish EXIT
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --fast ) ]]; then
  echo 'Usage: scripts/gate.sh [--fast]' >&2
  exit 1
fi
fast=${1:-}

run() {
  step=$1
  shift
  printf '\n==> %s\n' "$step"
  "$@"
}

counts() {
  local name=$1 file=$2 line passed= failed=
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+pass$ ]]; then
      passed=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+fail$ ]]; then
      failed=${BASH_REMATCH[1]}
    fi
  done < "$file"
  if [[ -z "$passed" || -z "$failed" ]]; then
    printf 'SUITE %s: counts unavailable (runner did not finish)\n' "$name"
    return 1
  fi
  printf 'SUITE %s: %s pass, %s fail\n' "$name" "$passed" "$failed"
  [[ "$passed" -gt 0 && "$failed" -eq 0 ]]
}

step=toolchain
if [[ -z "$fast" ]]; then
  [[ "$(uname -s)" == Linux && "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || {
    echo 'Run the full gate on Linux with Node 24 (CI toolchain)' >&2; exit 1;
  }
  # Read the pin without Bun so even a missing host Bun can be bootstrapped.
  expected_bun=$(node -p 'require("node:fs").readFileSync("mise.toml", "utf8").match(/^bun\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? ""')
  [[ -n "$expected_bun" ]] || { echo 'Cannot read the Bun pin from mise.toml' >&2; exit 1; }
  actual_bun=$(bun --version 2>/dev/null || true)
  if [[ "$actual_bun" != "$expected_bun" ]]; then
    bun_tools="$PWD/target/scratch/gate-tools"
    printf 'Fetching pinned Bun %s into %s (host Bun: %s)\n' "$expected_bun" "$bun_tools" "${actual_bun:-unavailable}"
    if npm install --prefix "$bun_tools" --no-save --package-lock=false "bun@$expected_bun"; then
      export PATH="$bun_tools/node_modules/.bin:$PATH"
      hash -r
    else
      status=$?
      printf 'Cannot obtain pinned Bun %s: npm install failed (exit %s)\n' "$expected_bun" "$status" >&2
      exit "$status"
    fi
  fi
  actual_bun=$(bun --version 2>/dev/null || true)
  [[ "$actual_bun" == "$expected_bun" ]] || {
    printf 'Cannot use pinned Bun %s: selected %s reports %s\n' "$expected_bun" "$(command -v bun || true)" "${actual_bun:-no version}" >&2
    exit 1
  }
fi
printf 'Toolchain: Bun %s (%s), Node %s\n' "$(bun --version)" "$(command -v bun)" "$(node --version)"
run frozen-lockfile bun install --frozen-lockfile
if [[ -z "$fast" ]]; then
  for host in opencode1 opencode2; do
    run "$host-host-install" npm ci --ignore-scripts --prefix "packages/opencode/src/tests/fixtures/$host-host"
  done
fi
run types bun run types
# Build also checks installed ranges, local dependency paths, and single copies
# of private-files, subc-client and common-auth before producing packaging inputs.
run build bun run build
run format bun run format:check
run lint bun run lint
step=ignored-worker-files
ignored=$(git ls-files -ci --exclude-standard -- .cortexkit)
if [[ -n "$ignored" ]]; then printf '%s\n' "$ignored"; exit 1; fi

step=packaging
mkdir -p target/scratch
logs=$(mktemp -d target/scratch/gate.XXXXXX)
status=0
(cd packages/opencode && bun test src/tests/*packaging.test.ts) > "$logs/packaging.log" 2>&1 || status=$?
counts packaging "$logs/packaging.log" || status=1
if [[ $status -ne 0 ]]; then tail -n 80 "$logs/packaging.log"; exit "$status"; fi
run pack-opencode bun run pack:opencode:dry
run pack-pi bun run pack:pi:dry
if [[ -n "$fast" ]]; then exit 0; fi

names=()
pids=()
suite() {
  local name=$1 directory=$2
  shift 2
  names+=("$name")
  (trap - EXIT; cd "$directory"; exec "$@") > "$logs/$name.log" 2>&1 &
  pids+=("$!")
}
failed=
collect() {
  local i status
  for i in "${!pids[@]}"; do
    status=0
    wait "${pids[$i]}" || status=$?
    counts "${names[$i]}" "$logs/${names[$i]}.log" || status=1
    if [[ $status -ne 0 ]]; then
      tail -n 80 "$logs/${names[$i]}.log"
      if [[ -z "$failed" ]]; then failed=${names[$i]}; fi
    fi
  done
  names=()
  pids=()
}
step=suites
# The OpenCode unit suite asserts real time limits (5 s test timeouts around
# vault and WebSocket timing). Run it alone after the other suites rather than
# beside the real-host suites, which saturate the job's cores.
suite core packages/core bun run test
suite pi packages/pi bun run test
suite opencode1-e2e packages/opencode env OPENAI_AUTH_OPENCODE1_E2E=1 bun test src/tests/opencode1-e2e.test.ts
suite opencode2-e2e packages/opencode env OPENAI_AUTH_OPENCODE2_E2E=1 bun test src/tests/opencode2-e2e.test.ts
collect
suite opencode packages/opencode bun run test
collect
if [[ -n "$failed" ]]; then step=$failed; exit 1; fi
