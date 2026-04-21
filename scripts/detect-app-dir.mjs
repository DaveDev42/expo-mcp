#!/usr/bin/env node
// Detects the Expo app directory inside the given project root.
// An "Expo app" is a directory containing package.json that depends on `expo`
// and has an app.json / app.config.{js,ts,cjs,mjs} next to it.
//
// Usage: detect-app-dir.mjs [project-root]
// Output:
//   Prints one relative path per line (POSIX, no leading ./). Empty if none found.
//   Exit 0 always; callers decide what to do with 0/1/many results.

import { readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const CONFIG_FILES = [
  'app.json',
  'app.config.js',
  'app.config.ts',
  'app.config.cjs',
  'app.config.mjs',
];

const PRUNE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'ios',
  'android',
  '.expo',
]);

const MAX_DEPTH = 3; // from the project root

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isExpoPkg(pkgPath) {
  let raw;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    return false;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return false;
  }
  const hasExpoDep =
    (obj.dependencies && 'expo' in obj.dependencies) ||
    (obj.devDependencies && 'expo' in obj.devDependencies);
  if (!hasExpoDep) return false;

  const dir = pkgPath.slice(0, -'/package.json'.length);
  return CONFIG_FILES.some((f) => {
    try {
      statSync(join(dir, f));
      return true;
    } catch {
      return false;
    }
  });
}

function* walk(dir, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (PRUNE.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const child = join(dir, e.name);
    const pkg = join(child, 'package.json');
    try {
      statSync(pkg);
      yield pkg;
    } catch {
      // no package.json at this level
    }
    yield* walk(child, depth + 1);
  }
}

const rawRoot = process.argv[2] || process.cwd();
const root = safeRealpath(rawRoot);
if (!root) process.exit(0);

// 1) Check the project root itself first — most common case.
const rootPkg = join(root, 'package.json');
try {
  statSync(rootPkg);
  if (isExpoPkg(rootPkg)) {
    process.stdout.write('.\n');
    process.exit(0);
  }
} catch {
  // root has no package.json
}

// 2) Walk monorepo locations.
for (const pkg of walk(root, 1)) {
  if (isExpoPkg(pkg)) {
    const dir = pkg.slice(0, -'/package.json'.length);
    const rel = relative(root, dir);
    process.stdout.write(`${rel}\n`);
  }
}
