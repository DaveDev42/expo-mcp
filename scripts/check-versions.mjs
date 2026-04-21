#!/usr/bin/env node
// Verify all four version-bearing files agree on a single version.
//
// Usage:
//   npm run check:versions        # prints the agreed version and exits 0;
//                                 # exits 1 with a breakdown if they drift.
//
// Used by CI (.github/workflows/ci.yml) and by release.mjs before tagging.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  { label: 'package.json', path: 'package.json', kind: 'json' },
  { label: '.claude-plugin/plugin.json', path: '.claude-plugin/plugin.json', kind: 'json' },
  {
    label: '.claude-plugin/marketplace.json (plugins[0])',
    path: '.claude-plugin/marketplace.json',
    kind: 'marketplace',
  },
  { label: 'src/index.ts (version literal)', path: 'src/index.ts', kind: 'src-literal' },
];

function readVersion({ path, kind }) {
  const raw = readFileSync(resolve(root, path), 'utf8');
  if (kind === 'src-literal') {
    const m = /console\.log\('expo-mcp ([^']+)'\)/.exec(raw);
    if (!m) throw new Error(`${path}: no expo-mcp version literal found`);
    return m[1];
  }
  const obj = JSON.parse(raw);
  if (kind === 'marketplace') {
    if (!Array.isArray(obj.plugins) || !obj.plugins[0]?.version) {
      throw new Error(`${path}: plugins[0].version missing`);
    }
    return obj.plugins[0].version;
  }
  if (!obj.version) throw new Error(`${path}: no version field`);
  return obj.version;
}

const readings = targets.map((t) => ({ ...t, version: readVersion(t) }));
const unique = [...new Set(readings.map((r) => r.version))];

if (unique.length === 1) {
  const [v] = unique;
  console.log(`version: ${v} (in sync)`);
  process.exit(0);
}

console.error('version: mismatch');
for (const r of readings) {
  console.error(`  ${r.version.padEnd(10)}  ${r.label}`);
}
process.exit(1);
