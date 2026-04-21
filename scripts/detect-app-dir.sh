#!/usr/bin/env bash
# Detects the Expo app directory inside the given project root.
# An "Expo app" is a directory containing package.json that depends on `expo`
# and has an app.json / app.config.{js,ts,cjs,mjs} next to it.
#
# Usage: detect-app-dir.sh [project-root]
# Output:
#   Prints one relative path per line (POSIX, no leading ./). Empty if none found.
#   Exit 0 always; callers decide what to do with 0/1/many results.

set -uo pipefail

RAW_ROOT="${1:-$PWD}"

if [ ! -d "$RAW_ROOT" ]; then
  exit 0
fi

# Canonicalize: resolve symlinks and trailing slashes so prefix-stripping is
# reliable (macOS /var vs /private/var, /tmp vs /private/tmp, etc.).
ROOT=$(cd "$RAW_ROOT" 2>/dev/null && pwd -P) || exit 0
ROOT="${ROOT%/}"

is_expo_pkg() {
  # $1 = absolute path to package.json
  # Heuristic: package.json mentions "expo" under dependencies or devDependencies,
  # and the directory contains an app config file.
  local pkg="$1"
  local dir
  dir=$(dirname "$pkg")
  if ! grep -q '"expo"[[:space:]]*:' "$pkg" 2>/dev/null; then
    return 1
  fi
  if [ -f "$dir/app.json" ] || [ -f "$dir/app.config.js" ] || [ -f "$dir/app.config.ts" ] || [ -f "$dir/app.config.cjs" ] || [ -f "$dir/app.config.mjs" ]; then
    return 0
  fi
  return 1
}

relpath() {
  # Strip the canonicalized $ROOT/ prefix to produce a relative path.
  local abs="$1"
  if [ "$abs" = "$ROOT" ]; then
    printf "."
    return
  fi
  # Use parameter expansion with a literal prefix — $ROOT is already canonical,
  # and bash does not treat the right-hand side as a glob here.
  local stripped="${abs#"$ROOT"/}"
  printf "%s" "$stripped"
}

# 1) Check the project root itself first — most common case.
if [ -f "$ROOT/package.json" ] && is_expo_pkg "$ROOT/package.json"; then
  printf ".\n"
  exit 0
fi

# 2) Walk common monorepo locations.
#    Canonicalize each found package.json so the prefix strip works.
while IFS= read -r pkg; do
  pkg_canon=$(cd "$(dirname "$pkg")" 2>/dev/null && pwd -P)/package.json
  if is_expo_pkg "$pkg_canon"; then
    dir=$(dirname "$pkg_canon")
    relpath "$dir"
    printf "\n"
  fi
done < <(find "$ROOT" \
  -mindepth 2 -maxdepth 4 \
  \( -path '*/node_modules' -o -path '*/.git' -o -path '*/dist' -o -path '*/build' -o -path '*/ios' -o -path '*/android' -o -path '*/.expo' \) -prune -o \
  -type f -name package.json -print 2>/dev/null)

exit 0
