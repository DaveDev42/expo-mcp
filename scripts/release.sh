#!/usr/bin/env bash
# One-click release for expo-mcp.
#
# Usage:
#   scripts/release.sh <version>   # e.g. scripts/release.sh 0.4.0
#   scripts/release.sh --dry-run <version>
#
# Performs, in order:
#   1. Preflight — must be on main, clean working tree, tag doesn't exist,
#      version is a valid semver greater than current.
#   2. scripts/sync-version.sh <version> — bumps the four version-bearing files.
#   3. npm run build — regenerates dist/.
#   4. npm run typecheck — sanity check.
#   5. git commit -m "chore: release v<version>" — bundles bump + rebuilt dist/.
#   6. git tag v<version>.
#   7. git push origin main && git push origin v<version>.
#
# With --dry-run, prints every command and stops before any mutation.
#
# Release artifacts (GitHub Release with auto-generated notes) are created by
# .github/workflows/release.yml on the tag push — this script only has to push.

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: release.sh [--dry-run] <version>" >&2
  exit 2
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' is not a valid semver" >&2
  exit 2
fi

TAG="v$VERSION"
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

run() {
  # Echo every command; execute unless dry-run.
  printf "+ %s\n" "$*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

## 1. Preflight

echo "== preflight =="

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "error: must be on main branch (currently on '$BRANCH')" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

# Make sure local main is not behind the remote; a release built on stale main
# would omit recent work.
git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "error: local main is not identical to origin/main" >&2
  echo "  local:  $LOCAL" >&2
  echo "  remote: $REMOTE" >&2
  echo "  run 'git pull --ff-only origin main' and retry" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: tag $TAG already exists locally" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists on origin" >&2
  exit 1
fi

CURRENT=$(scripts/sync-version.sh --check | sed -nE 's/^version: ([^ ]+) .*/\1/p')
if [ "$CURRENT" = "$VERSION" ]; then
  echo "error: current version is already $VERSION — bump to something new" >&2
  exit 1
fi

printf "releasing %s → %s\n\n" "$CURRENT" "$VERSION"

## 2. Version bump

echo "== version bump =="
run bash scripts/sync-version.sh "$VERSION"

## 3. Build

echo ""
echo "== build =="
run npm run build

## 4. Typecheck

echo ""
echo "== typecheck =="
run npm run typecheck

## 5. Commit

echo ""
echo "== commit =="
run git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json src/index.ts dist/
run git commit -m "chore: release $TAG"

## 6. Tag

echo ""
echo "== tag =="
run git tag -a "$TAG" -m "Release $TAG"

## 7. Push

echo ""
echo "== push =="
run git push origin main
run git push origin "$TAG"

echo ""
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run complete — no changes made"
else
  echo "released $TAG"
  echo "watch release workflow: gh run watch --exit-status"
fi
