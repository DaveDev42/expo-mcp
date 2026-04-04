#!/usr/bin/env bash
# Validates QA agent results contain actual app execution evidence.
# Prevents false PASS verdicts from code-review-only testing.
#
# Receives JSON via stdin from the SubagentStop hook event.
# Outputs a warning message if evidence is missing from a PASS verdict.

set -euo pipefail

INPUT=$(cat)

# Extract the agent's output text
OUTPUT=$(echo "$INPUT" | grep -oP '"transcript":\s*"[^"]*"' 2>/dev/null || echo "$INPUT")

# Only check PASS verdicts
if ! echo "$OUTPUT" | grep -qi "PASS"; then
  exit 0
fi

WARNINGS=""

# Check for app launch evidence
if ! echo "$OUTPUT" | grep -q "start_session"; then
  WARNINGS="${WARNINGS}\n- Missing start_session call (app was not launched)"
fi

# Check for UI verification evidence
if ! echo "$OUTPUT" | grep -q "inspect_view_hierarchy"; then
  WARNINGS="${WARNINGS}\n- Missing inspect_view_hierarchy call (UI was not verified)"
fi

# Check for interaction evidence
if ! echo "$OUTPUT" | grep -q "tap_on\|input_text\|run_maestro_flow\|press_key\|scroll\|swipe"; then
  WARNINGS="${WARNINGS}\n- Missing interaction tool calls (no user interactions performed)"
fi

if [ -n "$WARNINGS" ]; then
  echo "WARNING: QA PASS verdict may be invalid — missing execution evidence:"
  echo -e "$WARNINGS"
  echo ""
  echo "A valid PASS requires: start_session + inspect_view_hierarchy + interaction tools."
  echo "If the app was not actually tested, the verdict should be INCONCLUSIVE."
fi
