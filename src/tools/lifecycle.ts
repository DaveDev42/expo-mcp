import { z } from 'zod';
import { ExpoManager } from '../managers/expo.js';
import { SimulatorManager } from '../managers/simulator.js';
import { EmulatorManager } from '../managers/emulator.js';

export interface LifecycleTools {
  expoManager: ExpoManager;
  simulatorManager: SimulatorManager;
  emulatorManager: EmulatorManager;
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
      wait_for_ready: z.boolean().optional().describe('Wait for ready'),
      timeout_secs: z.number().optional().describe('Timeout'),
    }),
  },
  stop_expo: {
    name: 'stop_expo',
    description: 'Stop Expo server',
    inputSchema: z.object({}),
  },
  start_simulator: {
    name: 'start_simulator',
    description: 'Start iOS Simulator',
    inputSchema: z.object({
      device_name: z.string().optional().describe('Device name'),
      wait_for_boot: z.boolean().optional().describe('Wait for boot'),
      timeout_secs: z.number().optional().describe('Timeout'),
    }),
  },
  start_emulator: {
    name: 'start_emulator',
    description: 'Start Android Emulator',
    inputSchema: z.object({
      device_name: z.string().optional().describe('AVD name'),
      wait_for_boot: z.boolean().optional().describe('Wait for boot'),
      timeout_secs: z.number().optional().describe('Timeout'),
    }),
  },
  stop_device: {
    name: 'stop_device',
    description: 'Stop device',
    inputSchema: z.object({
      platform: z.enum(['ios', 'android']).optional().describe('Platform'),
    }),
  },
  install_app: {
    name: 'install_app',
    description: 'Install Expo Go on device',
    inputSchema: z.object({
      platform: z.enum(['ios', 'android']).describe('Platform'),
    }),
  },
  open_app: {
    name: 'open_app',
    description: 'Open Expo app URL in Expo Go',
    inputSchema: z.object({
      platform: z.enum(['ios', 'android']).optional().describe('Platform (auto-detect if not specified)'),
      url: z.string().optional().describe('Expo URL (uses running server if not specified)'),
    }),
  },
  launch_expo_go: {
    name: 'launch_expo_go',
    description: 'Launch Expo Go app',
    inputSchema: z.object({
      platform: z.enum(['ios', 'android']).optional().describe('Platform (auto-detect if not specified)'),
    }),
  },
};

export function createLifecycleHandlers(managers: LifecycleTools) {
  return {
    async app_status() {
      const expoStatus = managers.expoManager.getStatus();
      const expoPort = managers.expoManager.getPort();

      let device: {
        platform: 'ios' | 'android' | null;
        name: string | null;
        udid: string | null;
        expo_go_installed: boolean;
      } = {
        platform: null,
        name: null,
        udid: null,
        expo_go_installed: false,
      };

      // Check for booted iOS simulator
      try {
        const bootedSimulator = await managers.simulatorManager.getBootedDevice();
        if (bootedSimulator) {
          const expoGoInfo = await managers.simulatorManager.isExpoGoInstalled(bootedSimulator.udid);
          device = {
            platform: 'ios',
            name: bootedSimulator.name,
            udid: bootedSimulator.udid,
            expo_go_installed: expoGoInfo.installed,
          };
        }
      } catch {
        // No simulator available
      }

      // If no iOS device, check for Android emulator
      if (!device.platform) {
        try {
          const runningEmulator = await managers.emulatorManager.getRunningEmulator();
          if (runningEmulator) {
            const expoGoInfo = await managers.emulatorManager.isExpoGoInstalled();
            device = {
              platform: 'android',
              name: runningEmulator,
              udid: null,
              expo_go_installed: expoGoInfo.installed,
            };
          }
        } catch {
          // No emulator available
        }
      }

      const result = {
        expo_server: {
          status: expoStatus,
          port: expoPort,
          url: expoStatus === 'running' ? `exp://localhost:${expoPort}` : null,
        },
        device,
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
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                exp_url: `exp://localhost:${result.port}`,
                message: 'Expo server started. Use install_app to install Expo Go, then open_app to load the app.',
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

    async start_simulator(args: z.infer<typeof lifecycleToolSchemas.start_simulator.inputSchema>) {
      const result = await managers.simulatorManager.boot(args.device_name, {
        wait_for_boot: args.wait_for_boot,
        timeout_secs: args.timeout_secs,
      });

      // Check if Expo Go is installed
      const expoGoInfo = await managers.simulatorManager.isExpoGoInstalled(result.udid);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                expo_go_installed: expoGoInfo.installed,
                next_step: expoGoInfo.installed
                  ? 'Expo Go is installed. Use launch_expo to start the server, then open_app to load the app.'
                  : 'Expo Go not installed. Use install_app to install it.',
              },
              null,
              2
            ),
          },
        ],
      };
    },

    async start_emulator(args: z.infer<typeof lifecycleToolSchemas.start_emulator.inputSchema>) {
      const deviceName = await managers.emulatorManager.start(args.device_name, {
        wait_for_boot: args.wait_for_boot,
        timeout_secs: args.timeout_secs,
      });

      // Check if Expo Go is installed
      const expoGoInfo = await managers.emulatorManager.isExpoGoInstalled();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                name: deviceName,
                expo_go_installed: expoGoInfo.installed,
                next_step: expoGoInfo.installed
                  ? 'Expo Go is installed. Use launch_expo to start the server, then open_app to load the app.'
                  : 'Expo Go not installed. Use install_app to install it.',
              },
              null,
              2
            ),
          },
        ],
      };
    },

    async stop_device(args: z.infer<typeof lifecycleToolSchemas.stop_device.inputSchema>) {
      if (!args.platform || args.platform === 'ios') {
        try {
          await managers.simulatorManager.shutdown();
        } catch (error: any) {
          console.error('Failed to stop iOS simulator:', error.message);
        }
      }

      if (!args.platform || args.platform === 'android') {
        try {
          await managers.emulatorManager.stop();
        } catch (error: any) {
          console.error('Failed to stop Android emulator:', error.message);
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Stopped ${args.platform || 'all'} device(s)`,
          },
        ],
      };
    },

    async install_app(args: z.infer<typeof lifecycleToolSchemas.install_app.inputSchema>) {
      let result: { installed: boolean; message: string };

      if (args.platform === 'ios') {
        result = await managers.simulatorManager.installExpoGo();
      } else {
        result = await managers.emulatorManager.installExpoGo();
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                platform: args.platform,
                next_step: 'Expo Go installed. Use launch_expo to start the server, then open_app to load the app.',
              },
              null,
              2
            ),
          },
        ],
      };
    },

    async open_app(args: z.infer<typeof lifecycleToolSchemas.open_app.inputSchema>) {
      // Determine the URL to open
      let url = args.url;
      if (!url) {
        // Use the running Expo server
        const expoStatus = managers.expoManager.getStatus();
        if (expoStatus !== 'running') {
          throw new Error('No Expo server running. Start one with launch_expo first, or provide a URL.');
        }
        const port = managers.expoManager.getPort();
        url = `exp://localhost:${port}`;
      }

      // Determine the platform
      let platform = args.platform;
      if (!platform) {
        // Auto-detect
        const bootedSimulator = await managers.simulatorManager.getBootedDevice();
        if (bootedSimulator) {
          platform = 'ios';
        } else {
          const runningEmulator = await managers.emulatorManager.getRunningEmulator();
          if (runningEmulator) {
            platform = 'android';
          } else {
            throw new Error('No device running. Start a simulator or emulator first.');
          }
        }
      }

      let result: { success: boolean; message: string };

      if (platform === 'ios') {
        result = await managers.simulatorManager.openInExpoGo(url);
      } else {
        result = await managers.emulatorManager.openInExpoGo(url);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                platform,
                url,
              },
              null,
              2
            ),
          },
        ],
      };
    },

    async launch_expo_go(args: z.infer<typeof lifecycleToolSchemas.launch_expo_go.inputSchema>) {
      // Determine the platform
      let platform = args.platform;
      if (!platform) {
        // Auto-detect
        const bootedSimulator = await managers.simulatorManager.getBootedDevice();
        if (bootedSimulator) {
          platform = 'ios';
        } else {
          const runningEmulator = await managers.emulatorManager.getRunningEmulator();
          if (runningEmulator) {
            platform = 'android';
          } else {
            throw new Error('No device running. Start a simulator or emulator first.');
          }
        }
      }

      let result: { success: boolean; message: string };

      if (platform === 'ios') {
        result = await managers.simulatorManager.launchExpoGo();
      } else {
        result = await managers.emulatorManager.launchExpoGo();
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...result,
                platform,
              },
              null,
              2
            ),
          },
        ],
      };
    },
  };
}
