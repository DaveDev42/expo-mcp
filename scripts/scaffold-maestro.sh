#!/usr/bin/env bash
# Scaffolds a maestro/ directory in the given app root if one does not exist.
# Safe to run multiple times — never overwrites existing files.
#
# Usage: scaffold-maestro.sh <app-dir>

set -eu

APP_DIR="${1:-$PWD}"

if [ ! -d "$APP_DIR" ]; then
  echo "error: $APP_DIR is not a directory" >&2
  exit 2
fi

MAESTRO_DIR="$APP_DIR/maestro"

if [ -d "$MAESTRO_DIR" ]; then
  echo "maestro/ already exists at $MAESTRO_DIR — leaving untouched"
  exit 0
fi

mkdir -p "$MAESTRO_DIR"

cat > "$MAESTRO_DIR/smoke.yaml" <<'YAML'
# Smoke test — verifies the app launches and renders a known element.
# Run via: run_maestro_flow_files({ flow_files: "maestro/smoke.yaml" })
#
# `appId: any` works against whatever app is currently running (expo-mcp's
# start_session already launches it). Replace with your concrete bundle id
# (e.g., `com.example.app`) if you want the flow to launch the app itself.
# Replace the placeholder selector below with a stable element that is visible
# on your first screen (e.g., a testID on the root view or a splash/logo text).
appId: any
---
- waitForAnimationToEnd
# - assertVisible:
#     id: "app-root"
YAML

cat > "$MAESTRO_DIR/README.md" <<'MD'
# Maestro flows

This directory holds committed Maestro test flows for the app.

Conventions:
- One flow per user journey (login, checkout, onboarding, ...).
- Use kebab-case filenames: `login.yaml`, `add-to-cart.yaml`.
- Prefer `testID` selectors (`id:`) over visible text.
- Start each flow with `appId: any` so it works against the running session.

Ask the `flow-writer` agent to create a new flow, or run:

```
run_maestro_flow_files({ flow_files: "maestro/smoke.yaml" })
```
MD

echo "created $MAESTRO_DIR/smoke.yaml"
echo "created $MAESTRO_DIR/README.md"
