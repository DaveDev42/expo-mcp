#!/usr/bin/env bash
# Syncs the project version across the four files that carry it.
#
# Usage:
#   scripts/sync-version.sh <version>        # set version to <version>
#   scripts/sync-version.sh --check          # verify all four files agree;
#                                            # prints the version and exits 0
#                                            # if in sync, exits 1 otherwise
#
# Files touched:
#   package.json                      → "version": "X.Y.Z"
#   .claude-plugin/plugin.json        → "version": "X.Y.Z"
#   .claude-plugin/marketplace.json   → "version": "X.Y.Z"
#   src/index.ts                      → console.log('expo-mcp X.Y.Z');
#
# Keeps dist/ alone — callers run `npm run build` afterwards if they want a
# matching built artifact.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

pkg_version() {
  # Extract version from a JSON file via a tolerant regex. We avoid requiring jq.
  # Matches the first `"version": "X.Y.Z"` occurrence.
  local file="$1"
  sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$file" | head -n1
}

src_version() {
  # Extract version from the `expo-mcp X.Y.Z` log line in src/index.ts.
  sed -nE "s/.*console\.log\('expo-mcp ([^']+)'\).*/\1/p" src/index.ts | head -n1
}

print_all() {
  printf "package.json:       %s\n" "$(pkg_version package.json)"
  printf "plugin.json:        %s\n" "$(pkg_version .claude-plugin/plugin.json)"
  printf "marketplace.json:   %s\n" "$(pkg_version .claude-plugin/marketplace.json)"
  printf "src/index.ts:       %s\n" "$(src_version)"
}

if [ "${1:-}" = "--check" ]; then
  a=$(pkg_version package.json)
  b=$(pkg_version .claude-plugin/plugin.json)
  c=$(pkg_version .claude-plugin/marketplace.json)
  d=$(src_version)
  if [ "$a" = "$b" ] && [ "$b" = "$c" ] && [ "$c" = "$d" ] && [ -n "$a" ]; then
    printf "version: %s (in sync)\n" "$a"
    exit 0
  fi
  echo "version: mismatch" >&2
  print_all >&2
  exit 1
fi

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: sync-version.sh <version> | --check" >&2
  exit 2
fi

# Basic semver sanity (major.minor.patch with optional prerelease/build).
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' does not look like a semver (X.Y.Z)" >&2
  exit 2
fi

# In-place edits. BSD sed and GNU sed both accept `-i` differently; handle both.
sed_i() {
  if sed --version >/dev/null 2>&1; then
    sed -i -E "$@"
  else
    sed -i '' -E "$@"
  fi
}

sed_i "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/\"version\": \"$VERSION\"/" package.json
sed_i "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/\"version\": \"$VERSION\"/" .claude-plugin/plugin.json
sed_i "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/\"version\": \"$VERSION\"/" .claude-plugin/marketplace.json
sed_i "s/(console\.log\(')expo-mcp [^']+('\))/\1expo-mcp $VERSION\2/" src/index.ts

printf "bumped to %s\n" "$VERSION"
print_all
