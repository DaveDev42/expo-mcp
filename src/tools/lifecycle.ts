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
    description: 'Get Expo server status and current device info',
    inputSchema: z.object({}),
  },
  list_devices: {
    name: 'list_devices',
    description: 'List all available devices (iOS Simulators, Android Emulators) and show current target device',
    inputSchema: z.object({}),
  },
  switch_device: {
    name: 'switch_device',
    description: 'Switch to a different device for Maestro automation',
    inputSchema: z.object({
      device_id: z.string().describe('Device ID to switch to (get IDs from list_devices)'),
    }),
  },
  launch_expo: {
    name: 'launch_expo',
    description: 'Launch Expo dev server',
    inputSchema: z.object({
      // Target device
      target: z
        .enum(['ios-simulator', 'android-emulator', 'web-browser'])
        .optional()
        .describe('Target device to auto-launch'),

      // Connection mode
      host: z
        .enum(['lan', 'tunnel', 'localhost'])
        .optional()
        .describe('Connection mode: lan (physical devices), tunnel (remote), localhost (simulator)'),
      offline: z.boolean().optional().describe('Offline mode'),

      // Server settings
      port: z.number().optional().describe('Server port (default: 8081)'),
      clear: z.boolean().optional().describe('Clear bundler cache'),

      // Build options
      dev: z.boolean().optional().describe('Development mode (default: true)'),
      minify: z.boolean().optional().describe('Minify JavaScript'),
      max_workers: z.number().optional().describe('Max Metro workers'),

      // Other
      scheme: z.string().optional().describe('Custom URI scheme'),

      // expo-mcp specific
      wait_for_ready: z.boolean().optional().describe('Wait for server ready'),
      timeout_secs: z.number().optional().describe('Timeout in seconds'),
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
      limit: z.number().optional().describe('Maximum number of log lines to return (default: all)'),
      clear: z.boolean().optional().describe('Clear the log buffer after reading (default: false)'),
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

      // Get connected device info if server is running
      let device: { device_id: string; device_name: string; platform: string } | null = null;
      if (status === 'running') {
        device = await managers.maestroManager.getConnectedDevice();
      }

      const result = {
        expo_server: {
          status,
          port,
          target,
          host,
          url: status === 'running' ? `http://localhost:${port}` : null,
          exp_url: status === 'running' ? `exp://localhost:${port}` : null,
        },
        device: device
          ? {
              device_id: device.device_id,
              device_name: device.device_name,
              platform: device.platform,
            }
          : null,
        target_device_id: managers.maestroManager.getTargetDeviceId(),
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

    async list_devices() {
      const devices = await managers.maestroManager.listDevices();
      const targetDeviceId = managers.maestroManager.getTargetDeviceId();

      const result = {
        devices,
        target_device_id: targetDeviceId,
        hint: 'Use switch_device tool to change the target device',
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

    async switch_device(args: z.infer<typeof lifecycleToolSchemas.switch_device.inputSchema>) {
      const { device_id } = args;

      // Validate device exists
      const devices = await managers.maestroManager.listDevices();
      const deviceExists = devices.some((d) => d.device_id === device_id);

      if (!deviceExists) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Device not found: ${device_id}`,
                available_devices: devices.map((d) => ({ device_id: d.device_id, name: d.name })),
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      await managers.maestroManager.switchDevice(device_id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              target_device_id: device_id,
              message: `Switched to device: ${device_id}`,
            }, null, 2),
          },
        ],
      };
    },

    async launch_expo(args: z.infer<typeof lifecycleToolSchemas.launch_expo.inputSchema>) {
      const result = await managers.expoManager.launch(args);

      // Get connected device info after launching (poll until device is connected)
      let device: { device_id: string; device_name: string; platform: string } | null = null;
      if (result.target) {
        // Poll for device connection (max 30 seconds, check every 2 seconds)
        device = await managers.maestroManager.waitForDeviceConnection(30000, 2000);
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
        message = `Expo server started. ${targetName} launching...`;
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
