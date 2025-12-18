import { z } from 'zod';
import { ExpoManager } from '../managers/expo.js';

export interface LifecycleTools {
  expoManager: ExpoManager;
}

// Tool schemas (minimal descriptions for context efficiency)
export const lifecycleToolSchemas = {
  app_status: {
    name: 'app_status',
    description: 'Get app status',
    inputSchema: z.object({}),
  },
  launch_expo: {
    name: 'launch_expo',
    description: 'Launch Expo server',
    inputSchema: z.object({
      port: z.number().optional().describe('Port'),
      platform: z.enum(['ios', 'android']).optional().describe('Platform (launches simulator/emulator automatically)'),
      connection: z.enum(['lan', 'tunnel', 'localhost']).optional().describe('Connection mode: lan (default), tunnel (ngrok for remote devices), localhost (simulator only)'),
      hostname: z.string().optional().describe('Custom hostname override (e.g., "192.168.1.100")'),
      wait_for_ready: z.boolean().optional().describe('Wait for ready'),
      timeout_secs: z.number().optional().describe('Timeout'),
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
      const expoStatus = managers.expoManager.getStatus();
      const expoPort = managers.expoManager.getPort();
      const expoPlatform = managers.expoManager.getPlatform();

      const result = {
        expo_server: {
          status: expoStatus,
          port: expoPort,
          platform: expoPlatform,
          url: expoStatus === 'running' ? `exp://localhost:${expoPort}` : null,
        },
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
      const connectionInfo = result.connection.startsWith('custom:')
        ? `custom hostname (${result.connection.substring(7)})`
        : result.connection;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                exp_url: `exp://localhost:${result.port}`,
                message: result.platform
                  ? `Expo server started with ${result.platform} device (${connectionInfo} mode). App will open automatically.`
                  : `Expo server started (${connectionInfo} mode). Use --platform to auto-launch a device.`,
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
