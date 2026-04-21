#!/usr/bin/env node
// Scaffolds a maestro/ directory in the given app root if one does not exist.
// Safe to run multiple times — never overwrites existing files.
//
// Usage: scaffold-maestro.mjs [app-dir]
//   Defaults to the current working directory when called with no argument.

import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SMOKE_YAML = `# Smoke test — verifies the app launches and renders a known element.
# Run via: run_maestro_flow_files({ flow_files: "maestro/smoke.yaml" })
#
# \`appId: any\` works against whatever app is currently running (expo-mcp's
# start_session already launches it). Replace with your concrete bundle id
# (e.g., \`com.example.app\`) if you want the flow to launch the app itself.
# Replace the placeholder selector below with a stable element that is visible
# on your first screen (e.g., a testID on the root view or a splash/logo text).
appId: any
---
- waitForAnimationToEnd
# - assertVisible:
#     id: "app-root"
`;

const README_MD = `# Maestro flows

This directory holds committed Maestro test flows for the app.

Conventions:
- One flow per user journey (login, checkout, onboarding, ...).
- Use kebab-case filenames: \`login.yaml\`, \`add-to-cart.yaml\`.
- Prefer \`testID\` selectors (\`id:\`) over visible text.
- Start each flow with \`appId: any\` so it works against the running session.

Ask the \`flow-writer\` agent to create a new flow, or run:

\`\`\`
run_maestro_flow_files({ flow_files: "maestro/smoke.yaml" })
\`\`\`
`;

const appDir = process.argv[2] || process.cwd();

try {
  const s = statSync(appDir);
  if (!s.isDirectory()) throw new Error();
} catch {
  console.error(`error: ${appDir} is not a directory`);
  process.exit(2);
}

const maestroDir = join(appDir, 'maestro');

if (existsSync(maestroDir)) {
  console.log(`maestro/ already exists at ${maestroDir} — leaving untouched`);
  process.exit(0);
}

mkdirSync(maestroDir, { recursive: true });
writeFileSync(join(maestroDir, 'smoke.yaml'), SMOKE_YAML);
writeFileSync(join(maestroDir, 'README.md'), README_MD);

console.log(`created ${join(maestroDir, 'smoke.yaml')}`);
console.log(`created ${join(maestroDir, 'README.md')}`);
