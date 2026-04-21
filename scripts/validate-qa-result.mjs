#!/usr/bin/env node
// Validates QA agent results contain actual app execution evidence.
// Prevents false PASS verdicts from code-review-only testing.
//
// Receives JSON via stdin from the SubagentStop hook event.
// Prints a warning to stdout if evidence is missing from a PASS verdict.

import { readFileSync } from 'node:fs';

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const input = readStdinSync();

// Extract the transcript text if present; fall back to the raw envelope so we
// can still grep for evidence markers.
let body = input;
const m = input.match(/"transcript"\s*:\s*"((?:[^"\\]|\\.)*)"/);
if (m) body = m[1];

// Only validate PASS verdicts.
if (!/\bPASS\b/i.test(body)) process.exit(0);

const warnings = [];

if (!body.includes('start_session')) {
  warnings.push('- Missing start_session call (app was not launched)');
}
if (!body.includes('inspect_view_hierarchy')) {
  warnings.push('- Missing inspect_view_hierarchy call (UI was not verified)');
}
if (
  !/\b(tap_on|input_text|run_maestro_flow|press_key|scroll|swipe)\b/.test(body)
) {
  warnings.push('- Missing interaction tool calls (no user interactions performed)');
}

if (warnings.length > 0) {
  console.log('WARNING: QA PASS verdict may be invalid — missing execution evidence:');
  for (const w of warnings) console.log(w);
  console.log('');
  console.log('A valid PASS requires: start_session + inspect_view_hierarchy + interaction tools.');
  console.log('If the app was not actually tested, the verdict should be INCONCLUSIVE.');
}
