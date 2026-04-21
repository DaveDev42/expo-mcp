#!/usr/bin/env bash
# Verifies prerequisites for expo-mcp.
# Prints a human-readable report to stdout and exits non-zero if any required
# dependency is missing. Optional deps print warnings but do not fail.

set -uo pipefail

# Status labels — padded to 4 chars so the bracketed `[xxxx]` column aligns.
OK="  ok"
WARN="warn"
FAIL="fail"

fail=0
warn=0

header() { printf "\n== %s ==\n" "$1"; }
line()   { printf "[%s] %s\n" "$1" "$2"; }

header "Node.js"
if command -v node >/dev/null 2>&1; then
  node_version=$(node -v 2>/dev/null | sed 's/^v//')
  major=${node_version%%.*}
  if [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 18 ]; then
    line "$OK" "node $node_version"
  else
    line "$FAIL" "node $node_version (requires >=18)"
    fail=$((fail + 1))
  fi
else
  line "$FAIL" "node not found — install Node.js 18+ (https://nodejs.org)"
  fail=$((fail + 1))
fi

header "Maestro CLI"
MAESTRO_BIN="${MAESTRO_CLI_PATH:-$HOME/.maestro/bin/maestro}"
if [ -x "$MAESTRO_BIN" ]; then
  maestro_version=$("$MAESTRO_BIN" --version 2>/dev/null | head -n1)
  line "$OK" "maestro at $MAESTRO_BIN${maestro_version:+ ($maestro_version)}"
elif command -v maestro >/dev/null 2>&1; then
  maestro_version=$(maestro --version 2>/dev/null | head -n1)
  line "$OK" "maestro on PATH${maestro_version:+ ($maestro_version)}"
else
  line "$FAIL" "maestro not found — install with: curl -fsSL https://get.maestro.mobile.dev | bash"
  fail=$((fail + 1))
fi

# Run a command with a hard timeout. Prints stdout; returns the command's exit
# code, or 124 on timeout. Uses the background+kill trick so we don't depend on
# coreutils `timeout` being installed.
run_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM "$pid" 2>/dev/null
      # Short grace period, then SIGKILL if still alive.
      local grace=0
      while kill -0 "$pid" 2>/dev/null && [ "$grace" -lt 2 ]; do
        sleep 1
        grace=$((grace + 1))
      done
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

header "iOS tooling (optional)"
if [ "$(uname -s)" = "Darwin" ]; then
  if command -v xcrun >/dev/null 2>&1; then
    line "$OK" "xcrun available"
    sim_output=$(run_timeout 10 xcrun simctl list devices available 2>/dev/null || true)
    if [ -n "$sim_output" ]; then
      sim_count=$(printf "%s\n" "$sim_output" | grep -cE "\([0-9a-fA-F-]{36}\)" || true)
      line "$OK" "iOS simulators available: ${sim_count:-0}"
    else
      line "$WARN" "simctl timed out or returned nothing — open Xcode once to accept the license"
      warn=$((warn + 1))
    fi
  else
    line "$WARN" "xcrun not found — install Xcode for iOS simulator support"
    warn=$((warn + 1))
  fi
else
  line "$WARN" "not macOS — iOS simulator support unavailable"
  warn=$((warn + 1))
fi

header "Android tooling (optional)"
if command -v adb >/dev/null 2>&1; then
  line "$OK" "adb available"
  adb_output=$(run_timeout 5 adb devices 2>/dev/null || true)
  if printf "%s\n" "$adb_output" | tail -n +2 | grep -q .; then
    line "$OK" "android devices/emulators connected"
  else
    line "$WARN" "no android devices running — start an emulator via Android Studio"
    warn=$((warn + 1))
  fi
else
  line "$WARN" "adb not found — install Android Studio for emulator support"
  warn=$((warn + 1))
fi

header "Summary"
if [ "$fail" -gt 0 ]; then
  printf "[%s] %d required check(s) failed, %d warning(s)\n" "$FAIL" "$fail" "$warn"
  exit 1
fi
if [ "$warn" -gt 0 ]; then
  printf "[%s] all required checks passed, %d warning(s)\n" "$WARN" "$warn"
  exit 0
fi
printf "[%s] all checks passed\n" "$OK"
exit 0
