#!/usr/bin/env bash
set -euo pipefail

# release.sh — Tag and push a new CortexKit OpenAI auth release
#
# Usage:
#   ./scripts/release.sh 0.2.0        # release v0.2.0
#   ./scripts/release.sh 0.2.0 --dry  # preview without committing/pushing

VERSION="${1:-}"
DRY="${2:-}"

# Refuse anything that isn't exactly the dry-run flag. A mistyped flag such
# as --dry-run used to fall through to a real release that commits, tags,
# pushes and starts the npm publish.
if [[ $# -gt 2 || ( -n "$DRY" && "$DRY" != "--dry" ) ]]; then
  if [[ $# -gt 2 ]]; then BAD="${3}"; else BAD="$DRY"; fi
  echo "Error: unknown argument '$BAD'; the only option is --dry"
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version> [--dry]"
  echo "  e.g. ./scripts/release.sh 0.2.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Warning: releasing from '$BRANCH' (not main/master)"
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "  Releasing CortexKit OpenAI auth $TAG"
echo "  ───────────────────────────────────"
echo ""

# CI covers the source commit, before the version-only release edits.
RELEASE_SHA=$(git rev-parse HEAD)
REQUIRED_JOBS='["check", "check-macos", "runtime-layout-windows (windows-latest)", "runtime-layout-windows (windows-2022)"]'
CI_REASON=""
ci_passed() {
  local runs_json run run_id jobs_json failed_jobs
  if ! runs_json=$(gh api "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${RELEASE_SHA}&per_page=100" 2>&1); then
    CI_REASON="could not query CI for ${RELEASE_SHA}: ${runs_json}"
    return 1
  fi
  if ! run=$(jq -c --arg sha "$RELEASE_SHA" '[.workflow_runs[] | select(.head_sha == $sha and .head_branch == "main" and .event == "push")][0] // empty' <<< "$runs_json"); then
    CI_REASON="could not read CI runs for ${RELEASE_SHA}"
    return 1
  fi
  if [[ -z "$run" ]]; then
    CI_REASON="no main-branch CI push run for ${RELEASE_SHA}"
    return 1
  fi
  if [[ $(jq -r '.status' <<< "$run") != "completed" || $(jq -r '.conclusion' <<< "$run") != "success" ]]; then
    CI_REASON="CI for ${RELEASE_SHA} is $(jq -r '.status + "/" + (.conclusion // "pending")' <<< "$run"), not completed/success"
    return 1
  fi
  run_id=$(jq -r '.id' <<< "$run")
  if ! jobs_json=$(gh api "repos/{owner}/{repo}/actions/runs/${run_id}/jobs?per_page=100&filter=latest" 2>&1); then
    CI_REASON="could not query CI jobs for ${RELEASE_SHA}: ${jobs_json}"
    return 1
  fi
  if ! failed_jobs=$(jq -r --argjson required "$REQUIRED_JOBS" '
    . as $response
    | [$required[] as $name
       | ($response.jobs | map(select(.name == $name)) | .[0].conclusion // "missing") as $conclusion
       | select($conclusion != "success")
       | "\($name)=\($conclusion)"]
    | join(", ")
  ' <<< "$jobs_json"); then
    CI_REASON="could not read CI jobs for ${RELEASE_SHA}"
    return 1
  fi
  if [[ -n "$failed_jobs" ]]; then
    CI_REASON="required CI jobs not successful: ${failed_jobs}"
    return 1
  fi
}
CI_PASSED=false
if ci_passed; then CI_PASSED=true; fi

# Keep this allowlist aligned with version-sync.mjs: no other source edits
# may hitch a ride on a release that relies on the source commit's CI.
check_version_changes() {
  local path
  while IFS= read -r -d '' path; do
    case "$path" in
      packages/opencode/package.json|packages/pi/package.json|packages/opencode/src/version.ts|README.md|packages/opencode/README.md|packages/pi/README.md|docs/configuration.md|docs/opencode-2.md) ;;
      *) echo "Error: version sync changed a non-version file: $path" >&2; return 1 ;;
    esac
  done < <(git diff --no-renames --name-only -z HEAD; git ls-files --others --exclude-standard -z)
}

if [[ "$DRY" == "--dry" ]]; then
  echo "→ Version sync (dry run):"
  bun scripts/version-sync.mjs "$VERSION" --dry-run
  check_version_changes
  echo "[DRY RUN] Would run ./scripts/gate.sh --fast."
  if [[ "$CI_PASSED" == true ]]; then
    echo "[DRY RUN] Would skip the local suite because CI passed on $RELEASE_SHA on Linux, macOS and Windows."
  else
    echo "[DRY RUN] Would run bun run test: $CI_REASON"
  fi
  echo ""
  echo "[DRY RUN] Would commit, tag $TAG, and push to origin."
  exit 0
fi

echo "→ Syncing version to $VERSION..."
bun scripts/version-sync.mjs "$VERSION"
check_version_changes
echo ""

echo "→ Running pre-release checks..."
echo ""

if [[ "$CI_PASSED" == true ]]; then
  echo "  Skipping the local suite because CI passed on $RELEASE_SHA on Linux, macOS and Windows."
else
  echo "  Running bun run test: $CI_REASON"
fi

./scripts/gate.sh --fast

if [[ "$CI_PASSED" != true ]]; then
  bun run test 2>&1 || { echo "Error: Tests failed"; exit 1; }
fi

echo "  ✓ All checks passed"
echo ""

echo "→ Committing version bump..."
git add -A
if git diff --cached --quiet; then
  echo "  (no changes — version already at $VERSION)"
else
  git commit -m "release: $TAG"
fi

echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Release $TAG"
echo ""

echo "→ Pushing to origin..."
git push origin "$BRANCH" "$TAG"
echo ""

echo "  ✓ Released $TAG"
echo "  → GitHub Actions will now: test → build → publish to npm → create the GitHub release"
echo "  → Watch: https://github.com/cortexkit/openai-auth/actions"
