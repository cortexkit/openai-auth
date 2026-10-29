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

if [[ "$DRY" == "--dry" ]]; then
  echo "→ Version sync (dry run):"
  bun scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  echo "[DRY RUN] Would commit, tag $TAG, and push to origin."
  exit 0
fi

echo "→ Syncing version to $VERSION..."
bun scripts/version-sync.mjs "$VERSION"
echo ""

echo "→ Running pre-release checks..."
echo ""

./scripts/gate.sh --fast

echo "  bun test..."
bun run test 2>&1 || { echo "Error: Tests failed"; exit 1; }

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
