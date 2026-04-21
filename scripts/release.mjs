#!/usr/bin/env node
// Cut a new release of expo-mcp.
//
// Usage:
//   npm run release patch
//   npm run release minor
//   npm run release major
//   npm run release 0.4.0
//   npm run release -- --dry-run 0.4.0
//
// Performs, in order:
//   1. Preflight: on main, clean tree, up-to-date with origin/main, tag not
//      taken (locally or remote), new version differs from current, semver OK.
//   2. Bump version in all 4 files (package.json, plugin.json,
//      marketplace.json, src/index.ts version literal).
//   3. `npm run build` — regenerates dist/ so the pre-commit hook sees a clean
//      rebuild and the CI dist-sync check passes.
//   4. `npm run typecheck` — sanity.
//   5. `node scripts/check-versions.mjs` — self-check that the bump produced a
//      consistent set of files. Defence in depth.
//   6. `git commit -am "chore: release vX.Y.Z"`.
//   7. `git tag vX.Y.Z`.
//   8. `git push origin main && git push origin vX.Y.Z`.
//
// The GitHub Release (with auto-generated notes) is created by
// .github/workflows/release.yml on the tag push — this script only pushes.
//
// With --dry-run, echoes every command and stops before mutating anything.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const jsonFiles = [
  'package.json',
  '.claude-plugin/plugin.json',
];
const marketplaceFile = '.claude-plugin/marketplace.json';
const srcLiteralFile = 'src/index.ts';

// ---------- helpers ----------

let dryRun = false;

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', ...opts }).trim();
}

function run(cmd) {
  console.log(`+ ${cmd}`);
  if (!dryRun) execSync(cmd, { stdio: 'inherit', cwd: root });
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-.][0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function resolveNextVersion(current, arg) {
  if (parseSemver(arg)) return arg;
  const parts = parseSemver(current);
  if (!parts) fail(`current version is not semver: ${current}`);
  const [major, minor, patch] = parts;
  if (arg === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (arg === 'minor') return `${major}.${minor + 1}.0`;
  if (arg === 'major') return `${major + 1}.0.0`;
  fail(`unknown bump spec: ${arg} (use patch|minor|major|X.Y.Z)`);
  return null; // unreachable
}

function readCurrentVersion() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (!pkg.version) fail('root package.json has no version');
  return pkg.version;
}

function updateJson(path, mutate) {
  const abs = resolve(root, path);
  const raw = readFileSync(abs, 'utf8');
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  const obj = JSON.parse(raw);
  mutate(obj);
  if (dryRun) {
    console.log(`  [dry-run] would update ${path}`);
    return;
  }
  writeFileSync(abs, JSON.stringify(obj, null, 2) + trailingNewline);
  console.log(`  updated ${path}`);
}

function updateSrcLiteral(path, next) {
  const abs = resolve(root, path);
  const raw = readFileSync(abs, 'utf8');
  const updated = raw.replace(
    /(console\.log\(')expo-mcp [^']+('\))/,
    (_m, prefix, suffix) => `${prefix}expo-mcp ${next}${suffix}`,
  );
  if (updated === raw) fail(`no expo-mcp version literal matched in ${path}`);
  if (dryRun) {
    console.log(`  [dry-run] would update ${path}`);
    return;
  }
  writeFileSync(abs, updated);
  console.log(`  updated ${path}`);
}

// ---------- preflight ----------

function preflight(nextVersion) {
  console.log('== preflight ==');

  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') fail(`must be on main (currently on '${branch}')`);

  const status = sh('git status --porcelain');
  if (status) {
    console.error('error: working tree is dirty — commit or stash first');
    console.error(status);
    process.exit(1);
  }

  // Make sure local main matches origin/main so we don't release stale work.
  sh('git fetch --quiet origin main');
  const local = sh('git rev-parse HEAD');
  const remote = sh('git rev-parse origin/main');
  if (local !== remote) {
    fail(
      `local main (${local.slice(0, 7)}) is not identical to origin/main ` +
        `(${remote.slice(0, 7)}). run 'git pull --ff-only origin main' first.`,
    );
  }

  const tag = `v${nextVersion}`;
  try {
    sh(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: 'pipe' });
    fail(`tag ${tag} already exists locally`);
  } catch {
    // expected — tag doesn't exist
  }
  const remoteTag = sh(`git ls-remote --tags origin refs/tags/${tag} || true`);
  if (remoteTag) fail(`tag ${tag} already exists on origin`);

  const current = readCurrentVersion();
  if (current === nextVersion) {
    fail(`current version is already ${nextVersion} — pick something new`);
  }

  console.log(`releasing ${current} → ${nextVersion}`);
  console.log('');
  return { current, tag };
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--dry-run') {
    dryRun = true;
    args.shift();
  }
  const spec = args[0];
  if (!spec) {
    console.error('usage: npm run release -- [--dry-run] <patch|minor|major|X.Y.Z>');
    process.exit(2);
  }

  const current = readCurrentVersion();
  const next = resolveNextVersion(current, spec);

  const { tag } = preflight(next);

  console.log('== version bump ==');
  for (const f of jsonFiles) {
    updateJson(f, (obj) => {
      obj.version = next;
    });
  }
  updateJson(marketplaceFile, (obj) => {
    if (!Array.isArray(obj.plugins) || obj.plugins.length === 0) {
      fail(`${marketplaceFile}: plugins[] is empty`);
    }
    for (const p of obj.plugins) p.version = next;
  });
  updateSrcLiteral(srcLiteralFile, next);
  console.log('');

  console.log('== build ==');
  run('npm run build');
  console.log('');

  console.log('== typecheck ==');
  run('npm run typecheck');
  console.log('');

  console.log('== self-check ==');
  run('node scripts/check-versions.mjs');
  console.log('');

  console.log('== commit + tag + push ==');
  run('git add -A');
  run(`git commit -m "chore: release ${tag}"`);
  run(`git tag ${tag}`);
  run('git push origin main');
  run(`git push origin ${tag}`);
  console.log('');

  if (dryRun) {
    console.log('dry-run complete — no changes made');
  } else {
    console.log(`released ${tag}`);
    console.log('watch release workflow: gh run watch --exit-status');
  }
}

main();
