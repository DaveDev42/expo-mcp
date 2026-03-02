/**
 * Minimal semver utilities for Maestro CLI version checking.
 * Only supports the range format used by COMPATIBLE_MAESTRO_VERSION: ">=X.Y.Z <X.Y.Z"
 */

type SemVer = [number, number, number];

export function parseVersion(v: string): SemVer {
  // Handles plain "2.2.0" and prefixed "Maestro CLI v2.2.0" etc.
  const match = v.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid version: "${v}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: SemVer, b: SemVer): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Check if a version satisfies a simple range string.
 * Supports: ">=X.Y.Z <X.Y.Z" (space-separated constraints)
 * Each constraint: >=, >, <=, <, = followed by a version.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const ver = parseVersion(version);
  const constraints = range.trim().split(/\s+/);

  for (const constraint of constraints) {
    const match = constraint.match(/^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/);
    if (!match) {
      throw new Error(`Invalid range constraint: "${constraint}"`);
    }

    const op = match[1];
    const target = parseVersion(match[2]);
    const cmp = compareVersions(ver, target);

    switch (op) {
      case '>=': if (cmp < 0) return false; break;
      case '>':  if (cmp <= 0) return false; break;
      case '<=': if (cmp > 0) return false; break;
      case '<':  if (cmp >= 0) return false; break;
      case '=':  if (cmp !== 0) return false; break;
    }
  }

  return true;
}
