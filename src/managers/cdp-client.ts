/**
 * Chrome DevTools Protocol (CDP) I/O for on-device console capture.
 *
 * Keeps all network side-effects out of `cdp-verify.ts` (pure judgement) and
 * out of the already-large `lifecycle.ts`. Reuses the same `ws` dependency as
 * `expo.ts` (the only thing reload() uses) — zero new dependencies.
 *
 * The connection MUST send an Origin header: the dev server's debugger WS
 * (`/inspector/debug`) rejects connections whose origin is absent or untrusted
 * (InspectorProxy.js:369-387 — `URL.canParse(undefined) === false`). This is the
 * one deviation from `expo.ts` reload()'s no-options `new WebSocket(url)`.
 */

import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import type {
  CdpPageDescriptor,
  CapturedEntry,
  ConsoleApiCalledParams,
  LogEntryAddedParams,
} from './cdp-verify.js';
import { flattenConsoleArgs, normalizeLevel } from './cdp-verify.js';

/** GET http://localhost:{port}/json/list — the device page list (no WS opened). */
export async function fetchPageList(port: number): Promise<CdpPageDescriptor[]> {
  const res = await fetch(`http://localhost:${port}/json/list`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`/json/list returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as CdpPageDescriptor[]) : [];
}

export interface CaptureResult {
  /** Console + log entries observed during the window. */
  entries: CapturedEntry[];
  /** A new Runtime.executionContextCreated arrived after we attached (post-reload proof). */
  freshExecution: boolean;
  /** Runtime.evaluate echoed our nonce back (the runtime is genuinely executing JS). */
  nonceEchoed: boolean;
  /** ms actually spent capturing. */
  captureMs: number;
}

export interface CaptureOptions {
  /** ws://localhost:{port}/inspector/debug?device=...&page=... */
  webSocketDebuggerUrl: string;
  /** Origin header value — must equal the dev server origin, e.g. http://localhost:8081. */
  origin: string;
  /** Stop after this many ms with no new console/log event (settle-based window). */
  settleQuietMs: number;
  /** Hard ceiling on the capture window. */
  maxCaptureMs: number;
  /**
   * Called once subscriptions (Runtime.enable + Log.enable) are active, so the
   * caller can trigger the reload that should produce a fresh execution context.
   * Resolves the reload; capture continues regardless.
   */
  onSubscribed?: () => Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

/**
 * Open a CDP socket, subscribe to Runtime + Log, optionally trigger a reload,
 * and collect console/log output until the window settles or the ceiling hits.
 *
 * Liveness proof (the non-fakeable core):
 *  - `freshExecution`: a Runtime.executionContextCreated event arrives AFTER we
 *    sent Runtime.enable (a stale/dead page produces none for this reload).
 *  - `nonceEchoed`: Runtime.evaluate of `globalThis.__expo_mcp_nonce='<uuid>'`
 *    echoes the uuid back (a non-executing runtime cannot).
 */
export function captureDeviceConsole(opts: CaptureOptions): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve, reject) => {
    const nonce = randomUUID();
    const entries: CapturedEntry[] = [];
    let freshExecution = false;
    let nonceEchoed = false;
    let settled = false;
    const startedAt = Date.now();

    // CDP message id bookkeeping.
    const ID_RUNTIME_ENABLE = 1;
    const ID_LOG_ENABLE = 2;
    const ID_NONCE_EVAL = 3;
    let runtimeEnabled = false;
    let logEnabled = false;
    let nonceSent = false;

    const ws = new WebSocket(opts.webSocketDebuggerUrl, { origin: opts.origin });

    let quietTimer: NodeJS.Timeout | null = null;
    let ceilingTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      quietTimer = null;
      ceilingTimer = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        entries,
        freshExecution,
        nonceEchoed,
        captureMs: Date.now() - startedAt,
      });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // Reset the quiet-window timer on every new event.
    const bumpQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = global.setTimeout(finish, opts.settleQuietMs);
    };

    // Try to send the nonce evaluation once both Runtime + Log are enabled.
    const maybeSendNonce = () => {
      if (nonceSent || !runtimeEnabled || !logEnabled) return;
      nonceSent = true;
      ws.send(
        JSON.stringify({
          id: ID_NONCE_EVAL,
          method: 'Runtime.evaluate',
          params: {
            expression: `(globalThis.__expo_mcp_nonce=${JSON.stringify(nonce)})`,
            returnByValue: true,
          },
        })
      );
    };

    ceilingTimer = global.setTimeout(finish, opts.maxCaptureMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: ID_RUNTIME_ENABLE, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({ id: ID_LOG_ENABLE, method: 'Log.enable' }));
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Command acks.
      if (msg.id === ID_RUNTIME_ENABLE) {
        runtimeEnabled = true;
        maybeSendNonce();
        // Once subscribed, trigger the reload (so the fix re-executes) then start
        // the settle timer. We start the quiet window now so a runtime that emits
        // nothing still settles instead of hanging to the ceiling.
        if (logEnabled) {
          void runReloadThenSettle();
        }
        return;
      }
      if (msg.id === ID_LOG_ENABLE) {
        logEnabled = true;
        maybeSendNonce();
        if (runtimeEnabled) {
          void runReloadThenSettle();
        }
        return;
      }
      if (msg.id === ID_NONCE_EVAL) {
        const result = (msg.result as { result?: { value?: unknown } })?.result;
        if (result && result.value === nonce) {
          nonceEchoed = true;
        }
        return;
      }

      // Events.
      if (msg.method === 'Runtime.executionContextCreated') {
        // Any execution context created AFTER we attached proves a live runtime
        // (re)evaluated the bundle for this session.
        freshExecution = true;
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const params = msg.params as ConsoleApiCalledParams;
        entries.push({
          ts: Date.now(),
          channel: 'console',
          level: normalizeLevel(params?.type),
          text: flattenConsoleArgs(params),
        });
        bumpQuiet();
        return;
      }
      if (msg.method === 'Log.entryAdded') {
        const params = msg.params as LogEntryAddedParams;
        const entry = params?.entry;
        entries.push({
          ts: Date.now(),
          channel: 'log',
          level: normalizeLevel(entry?.level),
          text: entry?.text ?? '',
        });
        bumpQuiet();
        return;
      }
    });

    ws.on('error', (err: Error) => {
      // verifyClient rejection surfaces here as an HTTP 4xx during the upgrade.
      fail(new Error(`CDP socket error: ${err.message}`));
    });

    ws.on('close', () => {
      // If the socket closes before we settled (e.g. another debugger took over),
      // resolve with whatever we have rather than rejecting — the verdict layer
      // will judge the (possibly empty) capture.
      finish();
    });

    let reloadStarted = false;
    async function runReloadThenSettle() {
      if (reloadStarted) return;
      reloadStarted = true;
      try {
        if (opts.onSubscribed) {
          await opts.onSubscribed();
        }
      } catch {
        // A reload failure is judged via the stderr veto in the handler, not here.
      } finally {
        // Begin (or restart) the settle window after the reload is requested.
        bumpQuiet();
      }
    }
  });
}

export { randomUUID as cdpNonce };
