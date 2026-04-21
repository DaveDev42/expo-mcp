#!/usr/bin/env node
// Verifies prerequisites for expo-mcp.
// Prints a human-readable report to stdout and exits non-zero if any required
// dependency is missing. Optional deps print warnings but do not fail.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { platform as osPlatform, homedir } from 'node:os';
import { join } from 'node:path';

const OK = '  ok';
const WARN = 'warn';
const FAIL = 'fail';

let fail = 0;
let warn = 0;

const header = (s) => console.log(`\n== ${s} ==`);
const line = (tag, msg) => console.log(`[${tag}] ${msg}`);

// Run a command with a hard timeout. Returns { ok, stdout, timedOut }.
function runTimeout(cmd, args, timeoutMs) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  const timedOut = res.signal === 'SIGTERM' || res.error?.code === 'ETIMEDOUT';
  return {
    ok: !timedOut && res.status === 0,
    stdout: res.stdout || '',
    timedOut,
  };
}

function commandExists(cmd) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
  });
  return res.status === 0;
}

function isExecutable(path) {
  try {
    const s = statSync(path);
    return s.isFile();
  } catch {
    return false;
  }
}

// ---------- Node.js ----------

header('Node.js');
{
  const version = process.versions.node;
  const major = Number(version.split('.')[0]);
  if (Number.isFinite(major) && major >= 18) {
    line(OK, `node ${version}`);
  } else {
    line(FAIL, `node ${version} (requires >=18)`);
    fail++;
  }
}

// ---------- Maestro CLI ----------

header('Maestro CLI');
{
  const envPath = process.env.MAESTRO_CLI_PATH;
  const defaultPath = join(homedir(), '.maestro', 'bin', 'maestro');
  const maestroBin = envPath || defaultPath;

  if (isExecutable(maestroBin)) {
    const v = runTimeout(maestroBin, ['--version'], 5000);
    const version = v.ok ? v.stdout.split('\n')[0].trim() : '';
    line(OK, `maestro at ${maestroBin}${version ? ` (${version})` : ''}`);
  } else if (commandExists('maestro')) {
    const v = runTimeout('maestro', ['--version'], 5000);
    const version = v.ok ? v.stdout.split('\n')[0].trim() : '';
    line(OK, `maestro on PATH${version ? ` (${version})` : ''}`);
  } else {
    line(FAIL, 'maestro not found — install with: curl -fsSL https://get.maestro.mobile.dev | bash');
    fail++;
  }
}

// ---------- iOS tooling ----------

header('iOS tooling (optional)');
if (osPlatform() === 'darwin') {
  if (commandExists('xcrun')) {
    line(OK, 'xcrun available');
    const res = runTimeout('xcrun', ['simctl', 'list', 'devices', 'available'], 10000);
    if (res.ok && res.stdout) {
      // Match UUID-parenthesized lines: e.g. "iPhone 16 Pro (ABCDEF...)".
      const matches = res.stdout.match(/\([0-9a-fA-F-]{36}\)/g) || [];
      line(OK, `iOS simulators available: ${matches.length}`);
    } else if (res.timedOut) {
      line(WARN, 'simctl timed out — open Xcode once to accept the license');
      warn++;
    } else {
      line(WARN, 'simctl returned nothing — open Xcode once to accept the license');
      warn++;
    }
  } else {
    line(WARN, 'xcrun not found — install Xcode for iOS simulator support');
    warn++;
  }
} else {
  line(WARN, 'not macOS — iOS simulator support unavailable');
  warn++;
}

// ---------- Android tooling ----------

header('Android tooling (optional)');
if (commandExists('adb')) {
  line(OK, 'adb available');
  const res = runTimeout('adb', ['devices'], 5000);
  if (res.ok) {
    const devices = res.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    if (devices.length > 0) {
      line(OK, 'android devices/emulators connected');
    } else {
      line(WARN, 'no android devices running — start an emulator via Android Studio');
      warn++;
    }
  } else {
    line(WARN, 'adb devices failed to run');
    warn++;
  }
} else {
  line(WARN, 'adb not found — install Android Studio for emulator support');
  warn++;
}

// ---------- Summary ----------

header('Summary');
if (fail > 0) {
  line(FAIL, `${fail} required check(s) failed, ${warn} warning(s)`);
  process.exit(1);
}
if (warn > 0) {
  line(WARN, `all required checks passed, ${warn} warning(s)`);
  process.exit(0);
}
line(OK, 'all checks passed');
