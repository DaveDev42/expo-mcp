import { z } from 'zod';
import { ExpoManager } from '../managers/expo.js';
import { MaestroManager } from '../managers/maestro.js';

export interface LifecycleTools {
  expoManager: ExpoManager;
  maestroManager: MaestroManager;
}

// Tool schemas with clear descriptions
export const lifecycleToolSchemas = {
  app_status: {
    name: 'app_status',
    description: 'Get Expo server status and current session info',
    inputSchema: z.object({}),
  },
  launch_expo: {
    name: 'launch_expo',
    description: 'Launch Expo dev server',
    inputSchema: z.object({
      // Target device (required)
      target: z
        .enum(['ios-simulator', 'android-emulator', 'web-browser'])
        .describe('Target platform to launch: ios-simulator, android-emulator, or web-browser'),

      // Session reconnection
      device_id: z
        .string()
        .optional()
        .describe('Device ID for session reconnection. Use the device_id returned from a previous launch_expo call.'),

      // Connection mode
      host: z
        .enum(['lan', 'tunnel', 'localhost'])
        .optional()
        .describe('Connection mode: lan (physical devices), tunnel (remote), localhost (simulator)'),
      offline: z.coerce.boolean().optional().describe('Offline mode'),

      // Server settings
      port: z.coerce.number().optional().describe('Server port (default: 8081)'),
      clear: z.coerce.boolean().optional().describe('Clear bundler cache'),

      // Build options
      dev: z.coerce.boolean().optional().describe('Development mode (default: true)'),
      minify: z.coerce.boolean().optional().describe('Minify JavaScript'),
      max_workers: z.coerce.number().optional().describe('Max Metro workers'),

      // Other
      scheme: z.string().optional().describe('Custom URI scheme'),
      simulator_name: z.string().optional()
        .describe('iOS simulator name (e.g., "iPhone 16 Pro"). Only for ios-simulator target.'),
      clean_state: z.coerce.boolean().optional()
        .describe('Clean simulator state before launch (reset keychain, clear app data). Default: false'),
      skip_dev_menu_onboarding: z.coerce.boolean().optional()
        .describe('Skip Expo Go dev menu onboarding (default: true)'),
      auto_login: z.object({
        phone: z.string().optional().describe('Phone number'),
        password: z.string().optional().describe('Password'),
        flow_file: z.string().optional().describe('Custom Maestro YAML flow file path'),
      }).optional().describe('Auto-login after app loads. Also reads EXPO_TEST_PHONE/EXPO_TEST_PASSWORD env vars.'),

      // expo-mcp specific
      wait_for_ready: z.coerce.boolean().optional().describe('Wait for server ready'),
      timeout_secs: z.coerce.number().optional().describe('Timeout in seconds'),
    }),
  },
  stop_expo: {
    name: 'stop_expo',
    description: 'Stop Expo server',
    inputSchema: z.object({}),
  },
  reload_expo: {
    name: 'reload_expo',
    description: 'Reload the Expo app on connected devices (triggers Metro bundler refresh)',
    inputSchema: z.object({}),
  },
  get_logs: {
    name: 'get_logs',
    description: 'Get Metro bundler logs and console output from the running Expo app',
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
};

export function createLifecycleHandlers(managers: LifecycleTools) {
  return {
    async app_status() {
      const status = managers.expoManager.getStatus();
      const port = managers.expoManager.getPort();
      const target = managers.expoManager.getTarget();
      const host = managers.expoManager.getHost();
      const deviceId = managers.expoManager.getDeviceId();
      const hasSession = managers.expoManager.hasActiveSession();

      const result = {
        session_active: hasSession,
        expo_server: {
          status,
          port,
          target,
          host,
          url: status === 'running' ? `http://localhost:${port}` : null,
          exp_url: status === 'running' ? `exp://localhost:${port}` : null,
        },
        device_id: deviceId,
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

    async launch_expo(args: z.infer<typeof lifecycleToolSchemas.launch_expo.inputSchema>) {
      const { device_id: requestedDeviceId, ...launchOptions } = args;

      // If device_id is provided and Expo server is already running, switch to that device
      if (requestedDeviceId && managers.expoManager.getStatus() === 'running') {
        managers.expoManager.setDeviceId(requestedDeviceId);
        managers.maestroManager.setTargetDeviceId(requestedDeviceId);

        const port = managers.expoManager.getPort();
        const target = managers.expoManager.getTarget();
        const host = managers.expoManager.getHost();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'running',
                  port,
                  target,
                  host,
                  url: `http://localhost:${port}`,
                  exp_url: `exp://localhost:${port}`,
                  device_id: requestedDeviceId,
                  device_name: null,
                  platform: null,
                  message: `Session reconnected with device_id: ${requestedDeviceId}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const result = await managers.expoManager.launch(launchOptions);

      // Get connected device info after launching (poll until device is connected)
      let device: { device_id: string; device_name: string; platform: string } | null = null;
      if (result.target) {
        // Poll for device connection (max 30 seconds, check every 2 seconds)
        device = await managers.maestroManager.waitForDeviceConnection(30000, 2000);

        if (device) {
          // Store device_id in ExpoManager for session tracking
          managers.expoManager.setDeviceId(device.device_id);
          managers.maestroManager.setTargetDeviceId(device.device_id);
        } else {
          // Device detection failed, but keep server running
          // User can still manually interact with the app
          console.error(
            `[Expo] Warning: Could not detect device after launching ${result.target}. ` +
            `Maestro tools may not be available. Server will continue running.`
          );
        }
      }

      // Dev menu onboarding 억제 (기본: true)
      if ((args.skip_dev_menu_onboarding ?? true) && device) {
        managers.expoManager.suppressDevMenuOnboarding();
      }

      // 번들 완료 + 디바이스 준비 대기
      if (device) {
        await managers.expoManager.waitForBundleComplete(60000);
        const ready = await managers.maestroManager.verifyDeviceReady(device.device_id);
        if (!ready) {
          console.error('[Expo] Warning: Device readiness probe failed');
        }
      }

      // 자동 로그인
      const phone = args.auto_login?.phone || process.env.EXPO_TEST_PHONE;
      const password = args.auto_login?.password || process.env.EXPO_TEST_PASSWORD;

      if (device && (args.auto_login?.flow_file || (phone && password))) {
        try {
          if (args.auto_login?.flow_file) {
            await managers.maestroManager.callTool('run_flow_files', {
              device_id: device.device_id,
              flow_files: args.auto_login.flow_file,
            });
          } else {
            await managers.maestroManager.callTool('run_flow', {
              device_id: device.device_id,
              flow_yaml: [
                'appId: host.exp.Exponent',
                '---',
                `- tapOn: "전화번호"`,
                `- inputText: "${phone}"`,
                `- tapOn: "비밀번호"`,
                `- inputText: "${password}"`,
                `- tapOn: "로그인"`,
                `- waitForAnimationToEnd`,
              ].join('\n'),
            });
          }
          console.error('[Expo] Auto-login completed');
        } catch (e: any) {
          console.error(`[Expo] Auto-login failed (non-fatal): ${e.message}`);
        }
      }

      // Generate appropriate message based on target and host
      let message: string;
      if (result.target) {
        const targetName =
          result.target === 'ios-simulator'
            ? 'iOS Simulator'
            : result.target === 'android-emulator'
              ? 'Android Emulator'
              : 'Web Browser';
        if (device) {
          message = `Expo server started. ${targetName} connected (${device.device_name}).`;
        } else {
          message = `Expo server started. ${targetName} launched but device detection failed. Maestro tools may not be available.`;
        }
      } else if (result.host === 'tunnel') {
        message = 'Expo server started with tunnel. Scan QR code in terminal or use exp_url in Expo Go.';
      } else if (result.host === 'lan') {
        message = 'Expo server started on LAN. Scan QR code in terminal or use exp_url in Expo Go.';
      } else {
        message = 'Expo server started.';
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

    async stop_expo() {
      await managers.expoManager.stop();
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Expo server stopped',
          },
        ],
      };
    },

    async reload_expo() {
      await managers.expoManager.reload();
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Reload command sent to connected devices',
          },
        ],
      };
    },

    async get_logs(args: z.infer<typeof lifecycleToolSchemas.get_logs.inputSchema>) {
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
              text: 'No logs available. Make sure Expo server is running.',
            },
          ],
        };
      }

      // Format logs: [LEVEL] message
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
  };
}
