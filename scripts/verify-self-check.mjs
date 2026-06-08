#!/usr/bin/env node
// Self-check for the on-device console verification logic (cdp-verify.ts).
//
// No test framework (the repo has none — same convention as check-versions.mjs).
// We transpile the pure module with the already-present esbuild, then exercise
// the I/O-free functions with node:assert against recorded-shape CDP payloads.
//
// The load-bearing assertions are the FALSE-CLEAN regressions: a file-bundle /
// stale / empty-capture device must resolve to FAIL, never a silent clean pass.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'managers', 'cdp-verify.ts');

// Transpile cdp-verify.ts (pure, no imports) to a temp ESM file we can import.
const tmp = mkdtempSync(join(tmpdir(), 'expo-mcp-selfcheck-'));
const outfile = join(tmp, 'cdp-verify.mjs');
await build({
  entryPoints: [src],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  logLevel: 'silent',
});

const {
  filterHermesPages,
  selectHermesRuntimePage,
  flattenConsoleArgs,
  judgeSignatures,
  decideVerdict,
} = await import(pathToFileURL(outfile).href);

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// --- Fixtures: real-shape /json/list page descriptors --------------------------

const realHermesPage = {
  id: 'device123-1',
  title: 'Teleprompter',
  appId: 'app.tpmt.dev',
  webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?device=device123&page=1',
  deviceName: 'iPhone 15 Pro',
  reactNative: { logicalDeviceId: 'device123', capabilities: { nativePageReloads: true } },
};
// The synthetic fallback page: id ends "-1", empty capabilities (Device.js:357-364).
const syntheticPage = {
  id: 'device123--1',
  title: 'React Native Experimental (Improved Chrome Reloads)',
  appId: 'app.tpmt.dev',
  webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?device=device123&page=-1',
  deviceName: 'iPhone 15 Pro',
  reactNative: { logicalDeviceId: 'device123', capabilities: {} },
};

// --- filterHermesPages ---------------------------------------------------------

check('filterHermesPages keeps only non-synthetic Hermes pages', () => {
  const out = filterHermesPages([realHermesPage, syntheticPage], true);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'device123-1');
  assert.equal(out[0].isHermesRuntime, true);
  assert.equal(out[0].isSynthetic, false);
});

check('filterHermesPages flags the synthetic page as synthetic (not a runtime)', () => {
  const out = filterHermesPages([syntheticPage], false);
  assert.equal(out.length, 1);
  assert.equal(out[0].isSynthetic, true);
  assert.equal(out[0].isHermesRuntime, false);
});

check('filterHermesPages on a file-bundle device (empty list) yields no targets', () => {
  assert.equal(filterHermesPages([], true).length, 0);
});

check('selectHermesRuntimePage auto-picks the single runtime, null on ambiguity', () => {
  assert.equal(selectHermesRuntimePage([realHermesPage, syntheticPage])?.id, 'device123-1');
  const two = [realHermesPage, { ...realHermesPage, id: 'deviceX-1', webSocketDebuggerUrl: 'ws://x' }];
  assert.equal(selectHermesRuntimePage(two), null); // ambiguous → caller must pass page_id
  assert.equal(selectHermesRuntimePage(two, 'deviceX-1')?.id, 'deviceX-1');
});

// --- flattenConsoleArgs --------------------------------------------------------

check('flattenConsoleArgs joins RemoteObject previews into one line', () => {
  const params = {
    type: 'warn',
    args: [
      { type: 'string', value: "Deep imports from the 'react-native' package are deprecated ('react-native/Libraries/Core/ExceptionsManager')." },
    ],
  };
  const text = flattenConsoleArgs(params);
  assert.ok(text.includes("Deep imports from the 'react-native' package are deprecated"));
});

// --- judgeSignatures -----------------------------------------------------------

const deepImportLine = "Deep imports from the 'react-native' package are deprecated ('react-native/Libraries/Core/ExceptionsManager').";

check('absent signature: matched=0 → satisfied when the bad line is gone', () => {
  const entries = [{ ts: 0, channel: 'console', level: 'log', text: '[tp-app boot] 1.0.0' }];
  const [res] = judgeSignatures(entries, [
    { name: 'deep-import-deprecation', pattern: "Deep imports from the 'react-native' package are deprecated", expect: 'absent', severity: 'fail' },
  ]);
  assert.equal(res.matched, 0);
  assert.equal(res.satisfied, true);
});

check('absent signature: matched>0 → NOT satisfied when the bad line is present', () => {
  const entries = [{ ts: 0, channel: 'console', level: 'warn', text: deepImportLine }];
  const [res] = judgeSignatures(entries, [
    { name: 'deep-import-deprecation', pattern: "Deep imports from the 'react-native' package are deprecated", expect: 'absent', severity: 'fail' },
  ]);
  assert.equal(res.matched, 1);
  assert.equal(res.satisfied, false);
  assert.deepEqual(res.examples, [deepImportLine]);
});

check("the OLD wrong regex never matches the real line (why it was a false-clean)", () => {
  const entries = [{ ts: 0, channel: 'console', level: 'warn', text: deepImportLine }];
  const [res] = judgeSignatures(entries, [
    { name: 'old-wrong', pattern: '/Importing from "react-native\\/Libraries/', expect: 'absent', severity: 'fail' },
  ]);
  assert.equal(res.matched, 0, 'the rejected regex would wrongly report the warning as gone');
});

check('present signature (boot-marker): satisfied only when captured', () => {
  const withMarker = [{ ts: 0, channel: 'console', level: 'log', text: '[tp-app boot] 1.0.0' }];
  const without = [{ ts: 0, channel: 'console', level: 'log', text: 'something else' }];
  const sig = [{ name: 'boot-marker', pattern: '[tp-app boot]', expect: 'present', severity: 'fail' }];
  assert.equal(judgeSignatures(withMarker, sig)[0].satisfied, true);
  assert.equal(judgeSignatures(without, sig)[0].satisfied, false);
});

check('regex pattern with flags compiles; channels filter restricts entries', () => {
  const entries = [
    { ts: 0, channel: 'log', level: 'error', text: 'WebAssembly.RuntimeError: Aborted()' },
    { ts: 1, channel: 'console', level: 'log', text: 'benign' },
  ];
  const [res] = judgeSignatures(entries, [
    { name: 'wasm', pattern: '/WebAssembly\\.RuntimeError/i', expect: 'absent', severity: 'fail', channels: ['log'] },
  ]);
  assert.equal(res.matched, 1);
});

// --- decideVerdict: the false-clean gate (the irreplaceable assertions) ---------

const allSig = [{ name: 'boot-marker', expect: 'present', severity: 'fail', matched: 1, satisfied: true, examples: [] }];

check('GATE: no dev-bundle page → FAIL device_not_on_dev_bundle (the 0/0/0/0/0 trap)', () => {
  const v = decideVerdict({
    devBundleAttached: false,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: true, nonceEchoed: true,
    capturedEntries: 5, results: allSig,
  });
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.reason, 'device_not_on_dev_bundle');
});

check('GATE: reload not delivered → FAIL reload_not_delivered', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: false,
    freshExecution: true, nonceEchoed: true,
    capturedEntries: 5, results: allSig,
  });
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.reason, 'reload_not_delivered');
});

check('GATE: stale page (no fresh execution) → FAIL no_fresh_execution', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: false, nonceEchoed: true,
    capturedEntries: 5, results: allSig,
  });
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.reason, 'no_fresh_execution');
});

check('GATE: nonce not echoed → FAIL no_fresh_execution', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: true, nonceEchoed: false,
    capturedEntries: 5, results: allSig,
  });
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.reason, 'no_fresh_execution');
});

check('GATE: empty capture → FAIL empty_capture (never vacuous PASS of absent-signatures)', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: true, nonceEchoed: true,
    capturedEntries: 0, results: allSig,
  });
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.reason, 'empty_capture');
});

check('a fail-severity signature unsatisfied → FAIL', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: true, nonceEchoed: true,
    capturedEntries: 5,
    results: [{ name: 'deep-import', expect: 'absent', severity: 'fail', matched: 1, satisfied: false, examples: [] }],
  });
  assert.equal(v.verdict, 'FAIL');
});

check('a WARN-severity signature unsatisfied does NOT block PASS', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: true, nonceEchoed: true,
    capturedEntries: 5,
    results: [
      { name: 'libsodium-noise', expect: 'absent', severity: 'warn', matched: 2, satisfied: false, examples: [] },
      { name: 'boot-marker', expect: 'present', severity: 'fail', matched: 1, satisfied: true, examples: [] },
    ],
  });
  assert.equal(v.verdict, 'PASS');
});

check('all preconditions met + signatures satisfied → PASS (the only clean path)', () => {
  const v = decideVerdict({
    devBundleAttached: true,
    reloadRequested: true, reloadDelivered: true,
    freshExecution: true, nonceEchoed: true,
    capturedEntries: 5, results: allSig,
  });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.reason, 'ok');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\nverify-self-check: ${passed} assertions passed.`);
