/**
 * Pure, I/O-free helpers for on-device console-signature verification over CDP.
 *
 * The handlers in `tools/lifecycle.ts` do the network I/O (HTTP GET /json/list,
 * the CDP WebSocket); everything that decides *truth* lives here so it can be
 * unit-tested against recorded CDP payloads with no device attached.
 *
 * Why this exists: the Metro stdout buffer cannot distinguish a device running
 * the dev-server bundle from one that fell back to its embedded FILE bundle —
 * both look byte-identical (the 0/0/0/0/0 false-clean). The CDP inspector can:
 * a device is only reachable here if it opened the dev server's
 * `/inspector/device` WebSocket, i.e. it loaded Metro's dev bundle. See
 * InspectorProxy.js (#devices map) and Device.js (synthetic page) for the
 * grounding behind `filterHermesPages`.
 */

// ---------------------------------------------------------------------------
// Wire shapes (hand-typed against @react-native/dev-middleware + CDP protocol)
// ---------------------------------------------------------------------------

/** A single entry from GET http://localhost:{port}/json/list (InspectorProxy.js:188-206). */
export interface CdpPageDescriptor {
  id: string;
  title: string;
  description?: string;
  appId?: string | null;
  type?: string;
  webSocketDebuggerUrl: string;
  deviceName?: string | null;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: Record<string, unknown>;
  };
}

/** Normalised page after `filterHermesPages` — what the verify handler targets. */
export interface HermesPage {
  id: string;
  title: string;
  appId: string | null;
  deviceName: string | null;
  webSocketDebuggerUrl: string;
  isHermesRuntime: boolean;
  isSynthetic: boolean;
}

/** Runtime.consoleAPICalled / Log.entryAdded, flattened into one auditable line. */
export type CdpChannel = 'console' | 'log';

export interface CapturedEntry {
  ts: number;
  channel: CdpChannel;
  level: string;
  text: string;
}

// CDP message param shapes we actually read.
export interface RuntimeRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: { description?: string };
}

export interface ConsoleApiCalledParams {
  type?: string;
  args?: RuntimeRemoteObject[];
}

export interface LogEntryAddedParams {
  entry?: { level?: string; text?: string };
}

// ---------------------------------------------------------------------------
// Signature judgement
// ---------------------------------------------------------------------------

export type SignatureExpect = 'absent' | 'present';
export type SignatureSeverity = 'fail' | 'warn';

export interface ConsoleSignature {
  name: string;
  /** Literal substring by default, or `/regex/flags` when slash-wrapped. */
  pattern: string;
  expect?: SignatureExpect;
  severity?: SignatureSeverity;
  channels?: CdpChannel[];
}

export interface SignatureResult {
  name: string;
  expect: SignatureExpect;
  severity: SignatureSeverity;
  matched: number;
  satisfied: boolean;
  examples: string[];
}

export type Verdict = 'PASS' | 'FAIL';
export type VerdictReason =
  | 'ok'
  | 'device_not_on_dev_bundle'
  | 'reload_not_delivered'
  | 'no_fresh_execution'
  | 'empty_capture'
  | 'capture_failed'
  | 'origin_rejected';

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Reduce a /json/list payload to the pages that prove a dev-server bundle is
 * loaded: a real per-runtime Hermes page carries `capabilities.nativePageReloads
 * === true` (Device.js:402). The synthetic fallback page (Device.js:357-364) has
 * id "-1" and `capabilities: {}` — it survives a title-only filter even when the
 * runtime is stale/dead (getPagesList returns it whenever a legacy page EVER
 * connected, Device.js:190-196), so we must exclude it by capability, not title.
 *
 * `requireNativeReloads=true` (default) returns only non-synthetic Hermes pages.
 * `false` returns every page tagged with isHermesRuntime/isSynthetic for diagnostics.
 */
export function filterHermesPages(
  pages: CdpPageDescriptor[],
  requireNativeReloads = true
): HermesPage[] {
  const normalised: HermesPage[] = (pages ?? []).map((p) => {
    const caps = p.reactNative?.capabilities ?? {};
    const isHermesRuntime = caps['nativePageReloads'] === true;
    // The synthetic reloadable page: id ends in "-1" and has empty capabilities.
    const isSynthetic = p.id?.endsWith('-1') === true && Object.keys(caps).length === 0;
    return {
      id: p.id,
      title: p.title,
      appId: p.appId ?? null,
      deviceName: p.deviceName ?? null,
      webSocketDebuggerUrl: p.webSocketDebuggerUrl,
      isHermesRuntime,
      isSynthetic,
    };
  });

  if (!requireNativeReloads) return normalised;
  return normalised.filter((p) => p.isHermesRuntime && !p.isSynthetic);
}

/**
 * Pick the single page to attach to. With exactly one non-synthetic Hermes page,
 * that is the target. With more than one, the caller must disambiguate via
 * `pageId` (returns null here so the handler can surface the ambiguity).
 */
export function selectHermesRuntimePage(
  pages: CdpPageDescriptor[],
  pageId?: string
): HermesPage | null {
  const candidates = filterHermesPages(pages, true);
  if (pageId) {
    return candidates.find((p) => p.id === pageId) ?? null;
  }
  if (candidates.length === 1) return candidates[0];
  return null;
}

/** Render one Runtime.consoleAPICalled RemoteObject to a string for matching. */
function renderRemoteObject(arg: RuntimeRemoteObject): string {
  if (arg == null) return '';
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value !== undefined && arg.value !== null) return String(arg.value);
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  if (arg.preview?.description) return arg.preview.description;
  if (typeof arg.description === 'string') return arg.description;
  if (typeof arg.subtype === 'string') return arg.subtype;
  if (typeof arg.type === 'string') return arg.type;
  return '';
}

/**
 * Flatten a Runtime.consoleAPICalled params object into one line — the exact
 * text the device passed to console.* — by joining the rendered args with a
 * space. This is the load-bearing glue the rejected (start.log-derived) designs
 * never exercised.
 */
export function flattenConsoleArgs(params: ConsoleApiCalledParams): string {
  const args = params?.args ?? [];
  return args.map(renderRemoteObject).join(' ').trim();
}

/** Map a CDP console type / log level to our coarse level string. */
export function normalizeLevel(raw: string | undefined): string {
  if (!raw) return 'log';
  const r = raw.toLowerCase();
  if (r === 'warning') return 'warn';
  if (r === 'verbose' || r === 'debug') return 'debug';
  return r; // log | info | warn | error | debug | ...
}

const LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** Compile a signature pattern: `/body/flags` → RegExp, otherwise literal substring. */
function compileMatcher(pattern: string): (text: string) => boolean {
  if (pattern.length >= 2 && pattern.startsWith('/')) {
    const close = pattern.lastIndexOf('/');
    if (close > 0) {
      const body = pattern.slice(1, close);
      const flags = pattern.slice(close + 1);
      try {
        const re = new RegExp(body, flags);
        return (text) => re.test(text);
      } catch {
        // Fall through to literal on an invalid regex.
      }
    }
  }
  return (text) => text.includes(pattern);
}

/**
 * Judge every signature against the captured entries. A signature is `satisfied`
 * when `expect:'absent'` and matched===0, or `expect:'present'` and matched>0.
 * `min_level`/`channels` narrow the considered entries per signature.
 */
export function judgeSignatures(
  entries: CapturedEntry[],
  signatures: ConsoleSignature[]
): SignatureResult[] {
  return signatures.map((sig) => {
    const expect: SignatureExpect = sig.expect ?? 'absent';
    const severity: SignatureSeverity = sig.severity ?? 'fail';
    const channels = sig.channels;
    const matches = compileMatcher(sig.pattern);

    const considered = entries.filter((e) => {
      if (channels && !channels.includes(e.channel)) return false;
      return true;
    });

    const hits = considered.filter((e) => matches(e.text));
    const matched = hits.length;
    const satisfied = expect === 'absent' ? matched === 0 : matched > 0;

    return {
      name: sig.name,
      expect,
      severity,
      matched,
      satisfied,
      examples: hits.slice(0, 5).map((e) => e.text),
    };
  });
}

export interface VerdictInputs {
  devBundleAttached: boolean;
  reloadRequested: boolean;
  reloadDelivered: boolean;
  freshExecution: boolean;
  nonceEchoed: boolean;
  capturedEntries: number;
  results: SignatureResult[];
}

/**
 * Resolve the final verdict. PASS is the LAST, hardest branch: every liveness
 * precondition must hold (a file-bundle / stale / fix-not-run device cannot
 * satisfy them) AND every fail-severity signature must be satisfied. Any failure
 * short-circuits to FAIL with a distinct reason — never a silent clean pass.
 */
export function decideVerdict(inp: VerdictInputs): { verdict: Verdict; reason: VerdictReason } {
  // PRECOND 1 — a real non-synthetic Hermes runtime page exists.
  if (!inp.devBundleAttached) {
    return { verdict: 'FAIL', reason: 'device_not_on_dev_bundle' };
  }
  // PRECOND 2 — when we asked for a reload, it must have reached a live client.
  if (inp.reloadRequested && !inp.reloadDelivered) {
    return { verdict: 'FAIL', reason: 'reload_not_delivered' };
  }
  // PRECOND 3 — the non-fakeable core: fresh post-reload execution + nonce echo.
  if (!inp.freshExecution || !inp.nonceEchoed) {
    return { verdict: 'FAIL', reason: 'no_fresh_execution' };
  }
  // PRECOND 4 — the capture window actually observed runtime output.
  if (inp.capturedEntries === 0) {
    return { verdict: 'FAIL', reason: 'empty_capture' };
  }
  // Signature judgement — only fail-severity signatures block PASS.
  const blocking = inp.results.filter((r) => r.severity === 'fail');
  const allSatisfied = blocking.every((r) => r.satisfied);
  if (!allSatisfied) {
    return { verdict: 'FAIL', reason: 'ok' };
  }
  return { verdict: 'PASS', reason: 'ok' };
}
