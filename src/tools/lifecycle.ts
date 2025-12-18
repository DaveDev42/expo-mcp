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
    description: 'Get Expo server status',
    inputSchema: z.object({}),
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
      const result = await managers.expoManager.launch(args);

      // Get connected device info after launching (with small delay for device to connect)
      let device: { device_id: string; device_name: string; platform: string } | null = null;
      if (result.target) {
        // Wait a bit for simulator/emulator to be detected
        await new Promise((resolve) => setTimeout(resolve, 2000));
        device = await managers.maestroManager.getConnectedDevice();
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
  };
}
