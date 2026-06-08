import { z } from 'zod';
import { ExpoManager } from '../managers/expo.js';
import { MaestroManager } from '../managers/maestro.js';
import { InstanceRegistry } from '../registry/instance-registry.js';
import { fetchPageList, captureDeviceConsole } from '../managers/cdp-client.js';
import {
  filterHermesPages,
  selectHermesRuntimePage,
  judgeSignatures,
  decideVerdict,
} from '../managers/cdp-verify.js';

/** Device lease TTL — auto-renewed on every tool call that uses the device */
const DEFAULT_LEASE_TTL_MS = 2 * 60_000; // 2 minutes

/** Validate that a native device session is running and return its device ID. */
function requireNativeDevice(
  registry: InstanceRegistry,
  toolName: string
): { deviceId: string } {
  const state = registry.getSessionState();
  if (state.status !== 'running') {
    throw new Error('Session is not running. Call start_session first.');
  }
  if (state.target === 'web-browser') {
    throw new Error(`"${toolName}" requires a native device.`);
  }
  if (!state.deviceId) {
    throw new Error('Device lease expired. Call start_session to re-acquire.');
  }
  return { deviceId: state.deviceId };
}

export interface LifecycleTools {
  expoManager: ExpoManager;
  maestroManager: MaestroManager;
  registry: InstanceRegistry;
}

export const lifecycleToolSchemas = {
  get_session_status: {
    name: 'get_session_status',
    description:
      'Get current session status including server state, connected device, and device lease. ' +
      'Call this first to understand the current state before using other tools.',
    inputSchema: z.object({}),
  },
  start_session: {
    name: 'start_session',
    description:
      'Start a session: launches the Expo dev server, connects to a device, and acquires a device lease. ' +
      'The device lease is automatically renewed on every device tool call (take_screenshot, tap_on, etc). ' +
      'If the lease expires after 2 minutes of inactivity, call start_session again to reconnect. ' +
      'If the server is already running, this re-acquires the device lease without restarting.',
    inputSchema: z.object({
      target: z
        .enum(['ios-simulator', 'android-emulator', 'web-browser'])
        .describe('Target platform to launch: ios-simulator, android-emulator, or web-browser'),

      device_id: z
        .string()
        .optional()
        .describe(
          'Specific device to use (iOS simulator UUID or Android emulator serial like emulator-5554). ' +
          'If omitted, the first available connected device is used automatically.'
        ),

      host: z
        .enum(['lan', 'tunnel', 'localhost'])
        .optional()
        .describe('Connection mode: lan (physical devices), tunnel (remote), localhost (simulator)'),
      offline: z.coerce.boolean().optional().describe('Offline mode'),

      port: z.coerce.number().optional().describe('Server port (default: 8081)'),
      clear: z.coerce.boolean().optional().describe('Clear bundler cache'),

      dev: z.coerce.boolean().optional().describe('Development mode (default: true)'),
      minify: z.coerce.boolean().optional().describe('Minify JavaScript'),
      max_workers: z.coerce.number().optional().describe('Max Metro workers'),

      scheme: z.string().optional().describe('Custom URI scheme'),
      simulator_name: z.string().optional()
        .describe('iOS simulator name (e.g., "iPhone 16 Pro"). Only for ios-simulator target.'),
      clean_state: z.coerce.boolean().optional()
        .describe('Clean simulator state before launch (reset keychain, clear app data). Default: false'),
      skip_dev_menu_onboarding: z.coerce.boolean().optional()
        .describe('Skip Expo Go dev menu onboarding (default: true)'),
      auto_login: z.object({
        flow_file: z.string().describe(
          'Path to a Maestro YAML flow file to run after app loads. ' +
          'Env vars like EXPO_TEST_PHONE are available as ${EXPO_TEST_PHONE} in the flow.'
        ),
      }).optional().describe('Run a Maestro flow after app loads'),

      wait_for_ready: z.coerce.boolean().optional().describe('Wait for server ready'),
      timeout_secs: z.coerce.number().optional().describe('Timeout in seconds'),
    }),
  },
  stop_session: {
    name: 'stop_session',
    description:
      'Stop the session: shuts down the Expo dev server, releases the device, and cleans up all resources. ' +
      'Requires: session must be running (call start_session first).',
    inputSchema: z.object({}),
  },
  reload_app: {
    name: 'reload_app',
    description:
      'Reload the app on the connected device (triggers Metro bundler refresh). ' +
      'Requires: session must be running (call start_session first).',
    inputSchema: z.object({}),
  },
  get_logs: {
    name: 'get_logs',
    description:
      'Get Metro bundler logs and console output from the running app. ' +
      'Requires: session must be running (call start_session first).',
    inputSchema: z.object({
      limit: z.coerce.number().optional().describe('Maximum number of log lines to return (default: all)'),
      clear: z.coerce.boolean().optional().describe('Clear the log buffer after reading (default: false)'),
      level: z
        .enum(['log', 'info', 'warn', 'error'])
        .optional()
        .describe('Filter by minimum log level (log < info < warn < error)'),
      source: z.enum(['stdout', 'stderr']).optional().describe('Filter by output source'),
    }),
  },
  inspect_console_pages: {
    name: 'inspect_console_pages',
    description:
      'List the device debug pages reachable via the dev-server CDP inspector (GET /json/list). ' +
      'A device appears here ONLY if it loaded the Metro dev bundle (opened the inspector device WebSocket); ' +
      'a device that fell back to its embedded FILE bundle is structurally absent. ' +
      'Use this to confirm dev_bundle_attached before running verify_on_device. ' +
      'Requires: session must be running (call start_session first).',
    inputSchema: z.object({
      require_native_reloads: z.coerce
        .boolean()
        .optional()
        .default(true)
        .describe(
          'When true (default), filter to non-synthetic Hermes runtime pages ' +
          '(capabilities.nativePageReloads===true) — pages that prove a dev-server bundle is loaded. ' +
          'When false, return every page (incl. the synthetic id=-1 page) with isHermesRuntime/isSynthetic flags.'
        ),
    }),
  },
  verify_on_device: {
    name: 'verify_on_device',
    description:
      'Verify console signatures on a live device over CDP, with a structurally non-fakeable liveness gate. ' +
      'PASS requires: (1) a non-synthetic Hermes runtime page exists (device is on the dev bundle, not a file-bundle fallback), ' +
      '(2) the reload reached a live client, (3) a fresh post-reload execution context + nonce round-trip proves the bundle re-ran, ' +
      '(4) the capture window observed >=1 entry, AND (5) every fail-severity signature is satisfied. ' +
      'Any precondition failure returns verdict:FAIL with a distinct reason (never a silent 0-match clean pass). ' +
      'Requires: session must be running (call start_session first).',
    inputSchema: z.object({
      reload: z.coerce
        .boolean()
        .optional()
        .default(true)
        .describe('Reload before capture so the fix re-executes from a clean module graph. Required true for a real regression check.'),
      settle_quiet_ms: z.coerce
        .number()
        .optional()
        .default(1500)
        .describe('Stop capturing after this many ms with zero new console events (settle-based window, not a fixed sleep).'),
      max_capture_ms: z.coerce
        .number()
        .optional()
        .default(8000)
        .describe('Hard ceiling on the capture window in ms.'),
      require_dev_bundle: z.coerce
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Hard gate. When true (default), all liveness preconditions must pass or the whole verification FAILS — ' +
          'making a false-clean impossible. Exposed only so a human can intentionally observe a non-dev-bundle device.'
        ),
      page_id: z
        .string()
        .optional()
        .describe('Target page id from inspect_console_pages. Omit to auto-pick the single non-synthetic Hermes page; required only when >1 is attached.'),
      signatures: z
        .array(
          z.object({
            name: z.string().describe('Stable key, e.g. deep-import-deprecation.'),
            pattern: z.string().describe('Literal substring by default, or /regex/flags when slash-wrapped. Matched against the flattened console line text.'),
            expect: z
              .enum(['absent', 'present'])
              .optional()
              .default('absent')
              .describe('absent = FAIL on any match (regression guard, the common case); present = FAIL if no match (positive assertion).'),
            severity: z
              .enum(['fail', 'warn'])
              .optional()
              .default('fail')
              .describe('warn = reported in results but does not block PASS (for expected residual noise).'),
            channels: z
              .array(z.enum(['console', 'log']))
              .optional()
              .describe('Restrict to console (Runtime.consoleAPICalled) and/or log (Log.entryAdded). Default both.'),
          })
        )
        .min(1)
        .describe('Console signatures to judge. PASS = all liveness preconditions met AND every fail-severity signature satisfied.'),
    }),
  },
  press_key: {
    name: 'press_key',
    description:
      'Press a key on the device. For text input use input_text instead. ' +
      'Requires: start_session must be called first.',
    inputSchema: z.object({
      key: z
        .enum(['Enter', 'Backspace', 'Home', 'Lock', 'Tab', 'Volume Up', 'Volume Down'])
        .describe('The key to press'),
    }),
  },
  scroll: {
    name: 'scroll',
    description:
      'Scroll the screen. Requires: start_session must be called first.',
    inputSchema: z.object({
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .optional()
        .describe('Scroll direction (default: down)'),
    }),
  },
  swipe: {
    name: 'swipe',
    description:
      'Swipe on the screen. Use direction for simple swipes, or start+end for precise control. ' +
      'Requires: start_session must be called first.',
    inputSchema: z.object({
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .optional()
        .describe('Swipe direction (simple mode)'),
      start: z
        .string()
        .optional()
        .describe('Start point "x%,y%" (precise mode, use with end)'),
      end: z
        .string()
        .optional()
        .describe('End point "x%,y%" (precise mode, use with start)'),
      duration: z.coerce
        .number()
        .optional()
        .describe('Duration in ms (default: 400)'),
    }),
  },
};

export function createLifecycleHandlers(managers: LifecycleTools) {
  const { registry } = managers;

  // Sync registry when Expo process exits unexpectedly (crash, OOM, etc.)
  managers.expoManager.onExit((code) => {
    console.error(`[expo-mcp] Expo process exited unexpectedly (code ${code}), syncing registry`);
    registry.update({
      status: 'stopped',
      deviceId: null,
      deviceName: null,
      platform: null,
      port: null,
      target: null,
      host: 'lan',
      deviceLeasedAt: null,
      deviceLeaseExpiresAt: null,
      deviceLeaseTtlMs: null,
    });
  });

  return {
    async get_session_status() {
      // getSessionState() may self-evict expired lease, so call it first
      const state = registry.getSessionState();
      const record = registry.get();
      const status = managers.expoManager.getStatus();

      let deviceLease: { ttl_minutes: number; remaining_seconds: number } | null = null;
      if (record?.deviceLeaseExpiresAt && record.deviceLeaseTtlMs && state.deviceId) {
        const remaining = Math.max(0, record.deviceLeaseExpiresAt - Date.now());
        deviceLease = {
          ttl_minutes: record.deviceLeaseTtlMs / 60_000,
          remaining_seconds: Math.round(remaining / 1000),
        };
      }

      const result = {
        session_active: state.status === 'running' && (state.deviceId !== null || state.target === 'web-browser'),
        server: {
          status,
          port: state.port,
          target: state.target,
          host: state.host,
          url: status === 'running' && state.port ? `http://localhost:${state.port}` : null,
        },
        device: state.deviceId
          ? { device_id: state.deviceId, device_name: record?.deviceName ?? null, platform: record?.platform ?? null, lease: deviceLease }
          : null,
        instance_id: record?.instanceId ?? null,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    async start_session(args: z.infer<typeof lifecycleToolSchemas.start_session.inputSchema>) {
      const { device_id: requestedDeviceId, ...launchOptions } = args;

      // If server is already running, re-acquire device lease without restarting
      if (managers.expoManager.getStatus() === 'running') {
        let deviceId = requestedDeviceId;

        // If no device_id provided, auto-detect connected device
        let detectedDevice: { device_id: string; device_name: string; platform: string } | null = null;
        if (!deviceId) {
          detectedDevice = await managers.maestroManager.waitForDeviceConnection(10000, 2000);
          if (!detectedDevice) {
            throw new Error(
              'Server is already running but no connected device found. ' +
              'Provide a device_id or call stop_session first.'
            );
          }
          deviceId = detectedDevice.device_id;
        }

        // Check if device is claimed by another instance
        const claimer = registry.isDeviceClaimed(deviceId);
        if (claimer) {
          throw new Error(
            `Device ${deviceId} is in use by another instance (PID ${claimer.pid}, ${claimer.appDir}). ` +
            'Use list_devices to find available devices, or stop that instance first.'
          );
        }

        const now = Date.now();
        registry.update({
          deviceId,
          deviceName: detectedDevice?.device_name ?? null,
          platform: detectedDevice?.platform ?? null,
          deviceLeasedAt: now,
          deviceLeaseExpiresAt: now + DEFAULT_LEASE_TTL_MS,
          deviceLeaseTtlMs: DEFAULT_LEASE_TTL_MS,
        });

        const state = registry.getSessionState();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'running',
                  port: state.port,
                  target: state.target,
                  host: state.host,
                  device_id: deviceId,
                  message: 'Device lease renewed. Server was already running.',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Check device_id claim before launching
      if (requestedDeviceId) {
        const claimer = registry.isDeviceClaimed(requestedDeviceId);
        if (claimer) {
          const claimedIds = registry.getClaimedDeviceIds();
          throw new Error(
            `Device ${requestedDeviceId} is in use by another instance (PID ${claimer.pid}, ${claimer.appDir}). ` +
            `Claimed devices: ${claimedIds.join(', ') || 'none'}. ` +
            'Use list_devices to find available devices.'
          );
        }
      }

      // Update registry: starting
      registry.update({
        status: 'starting',
        port: launchOptions.port ?? 8081,
        target: launchOptions.target,
        host: launchOptions.host ?? (launchOptions.target === 'ios-simulator' ? 'localhost' : 'lan'),
      });

      let result: Awaited<ReturnType<typeof managers.expoManager.launch>>;
      try {
        result = await managers.expoManager.launch({
          ...launchOptions,
          isPortClaimed: (port) => registry.isPortClaimed(port),
        });
      } catch (err) {
        // Reset registry so it doesn't stay stuck in 'starting'
        registry.update({ status: 'stopped', port: null, target: null });
        throw err;
      }

      // Update registry: running with actual port
      registry.update({
        status: 'running',
        port: result.port,
        target: result.target,
        host: result.host,
      });

      // Get connected device info after launching (poll until device is connected)
      let device: { device_id: string; device_name: string; platform: string } | null = null;
      if (result.target && result.target !== 'web-browser') {
        device = await managers.maestroManager.waitForDeviceConnection(30000, 2000);

        if (device) {
          const now = Date.now();
          registry.update({
            deviceId: device.device_id,
            deviceName: device.device_name,
            platform: device.platform,
            deviceLeasedAt: now,
            deviceLeaseExpiresAt: now + DEFAULT_LEASE_TTL_MS,
            deviceLeaseTtlMs: DEFAULT_LEASE_TTL_MS,
          });
        } else {
          console.error(
            `[expo-mcp] Warning: Could not detect device after launching ${result.target}. ` +
            'Device tools may not work. Server will continue running.'
          );
        }
      }

      // Suppress dev menu onboarding (default: true)
      if ((args.skip_dev_menu_onboarding ?? true) && device) {
        managers.expoManager.suppressDevMenuOnboarding();
      }

      // Wait for bundle completion + device readiness
      if (device) {
        await managers.expoManager.waitForBundleComplete(60000);
        const ready = await managers.maestroManager.verifyDeviceReady(device.device_id);
        if (!ready) {
          console.error('[expo-mcp] Warning: Device readiness probe failed');
        }
      }

      // Auto-login via flow file
      if (device && args.auto_login?.flow_file) {
        try {
          await managers.maestroManager.callTool('run_flow_files', {
            device_id: device.device_id,
            flow_files: args.auto_login.flow_file,
          });
          console.error('[expo-mcp] Auto-login flow completed');
        } catch (e: any) {
          console.error(`[expo-mcp] Auto-login flow failed (non-fatal): ${e.message}`);
        }
      }

      // Generate message
      let message: string;
      if (result.target) {
        const targetName =
          result.target === 'ios-simulator'
            ? 'iOS Simulator'
            : result.target === 'android-emulator'
              ? 'Android Emulator'
              : 'Web Browser';
        if (device) {
          message = `Session started. ${targetName} connected (${device.device_name}).`;
        } else {
          message = `Server started on ${targetName} but device detection failed. Device tools may not work.`;
        }
      } else if (result.host === 'tunnel') {
        message = 'Server started with tunnel. Scan QR code in terminal or use exp_url in Expo Go.';
      } else if (result.host === 'lan') {
        message = 'Server started on LAN. Scan QR code in terminal or use exp_url in Expo Go.';
      } else {
        message = 'Server started.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                device_id: device?.device_id ?? null,
                device_name: device?.device_name ?? null,
                platform: device?.platform ?? null,
                message,
              },
              null,
              2
            ),
          },
        ],
      };
    },

    async stop_session() {
      if (managers.expoManager.getStatus() !== 'running') {
        throw new Error('Session is not running. Nothing to stop.');
      }

      await managers.expoManager.stop();
      registry.update({
        status: 'stopped',
        deviceId: null,
        deviceName: null,
        platform: null,
        port: null,
        target: null,
        host: 'lan',
        // maestroPid intentionally kept — Maestro subprocess stays alive across sessions
        deviceLeasedAt: null,
        deviceLeaseExpiresAt: null,
        deviceLeaseTtlMs: null,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Session stopped and device released.',
          },
        ],
      };
    },

    async reload_app() {
      if (managers.expoManager.getStatus() !== 'running') {
        throw new Error('Session is not running. Call start_session first.');
      }

      await managers.expoManager.reload();
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Reload command sent to connected device.',
          },
        ],
      };
    },

    async get_logs(args: z.infer<typeof lifecycleToolSchemas.get_logs.inputSchema>) {
      if (managers.expoManager.getStatus() !== 'running') {
        throw new Error('Session is not running. Call start_session first.');
      }

      const logs = managers.expoManager.getLogs({
        limit: args.limit,
        clear: args.clear,
        level: args.level,
        source: args.source,
      });

      if (logs.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No logs available.',
            },
          ],
        };
      }

      const formatted = logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`).join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: formatted,
          },
        ],
      };
    },

    async inspect_console_pages(
      args: z.infer<typeof lifecycleToolSchemas.inspect_console_pages.inputSchema>
    ) {
      if (managers.expoManager.getStatus() !== 'running') {
        throw new Error('Session is not running. Call start_session first.');
      }
      const port = managers.expoManager.getPort();
      if (!port) {
        throw new Error('No dev-server port available.');
      }

      let pages;
      try {
        const raw = await fetchPageList(port);
        pages = filterHermesPages(raw, args.require_native_reloads);
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { ok: false, port, dev_bundle_attached: false, pages: [], error: err.message },
                null,
                2
              ),
            },
          ],
        };
      }

      const devBundleAttached = pages.some((p) => p.isHermesRuntime && !p.isSynthetic);
      registry.touchLease();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ok: true, port, dev_bundle_attached: devBundleAttached, pages },
              null,
              2
            ),
          },
        ],
      };
    },

    async verify_on_device(
      args: z.infer<typeof lifecycleToolSchemas.verify_on_device.inputSchema>
    ) {
      if (managers.expoManager.getStatus() !== 'running') {
        throw new Error('Session is not running. Call start_session first.');
      }
      const port = managers.expoManager.getPort();
      if (!port) {
        throw new Error('No dev-server port available.');
      }
      registry.touchLease();

      const fail = (
        reason: string,
        extra: Record<string, unknown> = {}
      ) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                verdict: 'FAIL',
                reason,
                dev_bundle_attached: false,
                page: null,
                reloaded: false,
                fresh_execution_proved: false,
                nonce_echoed: false,
                captured_entries: 0,
                capture_ms: 0,
                file_fallback_seen: false,
                signatures: [],
                sample_lines: [],
                ...extra,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      });

      // PRECOND 1 — a non-synthetic Hermes runtime page must exist.
      let rawPages;
      try {
        rawPages = await fetchPageList(port);
      } catch (err: any) {
        return fail('capture_failed', { error: `/json/list: ${err.message}` });
      }
      const target = selectHermesRuntimePage(rawPages, args.page_id);
      const devBundleAttached = filterHermesPages(rawPages, true).length > 0;

      if (args.require_dev_bundle && !target) {
        // Either no dev-bundle device, or >1 and no page_id given.
        const candidates = filterHermesPages(rawPages, true);
        if (candidates.length > 1) {
          return fail('capture_failed', {
            dev_bundle_attached: true,
            error: `Multiple dev-bundle pages attached; pass page_id. Candidates: ${candidates
              .map((c) => c.id)
              .join(', ')}`,
          });
        }
        return fail('device_not_on_dev_bundle', { dev_bundle_attached: false });
      }
      if (!target) {
        return fail('device_not_on_dev_bundle', { dev_bundle_attached: devBundleAttached });
      }

      const origin = `http://localhost:${port}`;

      // PRECOND 2 — capture window with a reload-then-settle, proving fresh execution.
      let capture;
      try {
        capture = await captureDeviceConsole({
          webSocketDebuggerUrl: target.webSocketDebuggerUrl,
          origin,
          settleQuietMs: args.settle_quiet_ms,
          maxCaptureMs: args.max_capture_ms,
          onSubscribed: args.reload
            ? async () => {
                await managers.expoManager.reload();
              }
            : undefined,
        });
      } catch (err: any) {
        const isOrigin = /401|403|origin/i.test(err.message ?? '');
        return fail(isOrigin ? 'origin_rejected' : 'capture_failed', {
          dev_bundle_attached: true,
          page: { id: target.id, title: target.title, appId: target.appId, deviceName: target.deviceName },
          error: err.message,
        });
      }

      // Reload-delivery veto: Metro logs "No apps connected" to stderr when no RN
      // client received the reload (createMessageSocket.js). Corroborating signal.
      const stderrLogs = managers.expoManager.getLogs({ source: 'stderr', limit: 30 });
      const fileFallbackSeen = stderrLogs.some((l) =>
        /No apps connected\.\s*Sending\s*"reload"/i.test(l.message)
      );
      const reloadDelivered = args.reload ? !fileFallbackSeen : true;

      const results = judgeSignatures(capture.entries, args.signatures);
      const { verdict, reason } = decideVerdict({
        devBundleAttached: true,
        reloadRequested: args.reload,
        reloadDelivered,
        freshExecution: capture.freshExecution,
        nonceEchoed: capture.nonceEchoed,
        capturedEntries: capture.entries.length,
        results,
      });

      const payload = {
        verdict,
        reason,
        dev_bundle_attached: true,
        page: { id: target.id, title: target.title, appId: target.appId, deviceName: target.deviceName },
        reloaded: args.reload,
        fresh_execution_proved: capture.freshExecution,
        nonce_echoed: capture.nonceEchoed,
        captured_entries: capture.entries.length,
        capture_ms: capture.captureMs,
        file_fallback_seen: fileFallbackSeen,
        signatures: results,
        sample_lines: capture.entries.slice(0, 20).map((e) => `[${e.level}] ${e.text}`),
      };

      registry.touchLease();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        isError: verdict !== 'PASS',
      };
    },

    async press_key(args: z.infer<typeof lifecycleToolSchemas.press_key.inputSchema>) {
      const { deviceId } = requireNativeDevice(registry, 'press_key');
      const flowYaml = `appId: any\n---\n- pressKey: ${args.key}`;
      const result = await managers.maestroManager.callTool('run_flow', {
        flow_yaml: flowYaml,
        device_id: deviceId,
      });
      registry.touchLease();
      return result;
    },

    async scroll(args: z.infer<typeof lifecycleToolSchemas.scroll.inputSchema>) {
      const { deviceId } = requireNativeDevice(registry, 'scroll');
      const direction = args.direction?.toUpperCase();
      // Maestro 2.2.0: `scroll` has no direction property.
      // Use `- scroll` for default (down), use `swipe` for other directions.
      let commands: string;
      if (!direction || direction === 'DOWN') {
        commands = '- scroll';
      } else {
        commands = `- swipe:\n    direction: ${direction}`;
      }
      const flowYaml = `appId: any\n---\n${commands}`;
      const result = await managers.maestroManager.callTool('run_flow', {
        flow_yaml: flowYaml,
        device_id: deviceId,
      });
      registry.touchLease();
      return result;
    },

    async swipe(args: z.infer<typeof lifecycleToolSchemas.swipe.inputSchema>) {
      const { deviceId } = requireNativeDevice(registry, 'swipe');

      let commands: string;
      if (args.start && args.end) {
        // Precise mode with start/end points
        commands = `- swipe:\n    start: "${args.start}"\n    end: "${args.end}"`;
        if (args.duration) {
          commands += `\n    duration: ${args.duration}`;
        }
      } else if (args.direction) {
        // Simple direction mode
        commands = `- swipe:\n    direction: ${args.direction.toUpperCase()}`;
        if (args.duration) {
          commands += `\n    duration: ${args.duration}`;
        }
      } else {
        throw new Error('Either "direction" or both "start" and "end" must be provided.');
      }

      const flowYaml = `appId: any\n---\n${commands}`;
      const result = await managers.maestroManager.callTool('run_flow', {
        flow_yaml: flowYaml,
        device_id: deviceId,
      });
      registry.touchLease();
      return result;
    },
  };
}
