import { z } from 'zod';
import { ExpoManager } from '../managers/expo.js';
import { SimulatorManager } from '../managers/simulator.js';
import { EmulatorManager } from '../managers/emulator.js';

export interface LifecycleTools {
  expoManager: ExpoManager;
  simulatorManager: SimulatorManager;
  emulatorManager: EmulatorManager;
}

export const lifecycleToolSchemas = {
  app_status: {
    name: 'app_status',
    description: 'Get the current status of the mobile app development environment (Expo server, device, app installation)',
    inputSchema: z.object({}),
  },
  launch_expo: {
    name: 'launch_expo',
    description: 'Launch the Expo development server for the mobile app',
    inputSchema: z.object({
      port: z.number().optional().describe('Port number for Expo server (default: 8081)'),
      wait_for_ready: z.boolean().optional().describe('Wait for server to be ready (default: true)'),
      timeout_secs: z.number().optional().describe('Timeout in seconds (default: 60)'),
    }),
  },
  stop_expo: {
    name: 'stop_expo',
    description: 'Stop the running Expo development server',
    inputSchema: z.object({}),
  },
  start_simulator: {
    name: 'start_simulator',
    description: 'Start an iOS Simulator',
    inputSchema: z.object({
      device_name: z.string().optional().describe('Specific simulator name (e.g., "iPhone 15 Pro"). If not specified, uses first available iPhone.'),
      wait_for_boot: z.boolean().optional().describe('Wait for simulator to fully boot (default: true)'),
      timeout_secs: z.number().optional().describe('Timeout in seconds (default: 120)'),
    }),
  },
  start_emulator: {
    name: 'start_emulator',
    description: 'Start an Android Emulator',
    inputSchema: z.object({
      device_name: z.string().optional().describe('Specific emulator AVD name (e.g., "Pixel_7_API_34"). If not specified, uses first available.'),
      wait_for_boot: z.boolean().optional().describe('Wait for emulator to fully boot (default: true)'),
      timeout_secs: z.number().optional().describe('Timeout in seconds (default: 120)'),
    }),
  },
  stop_device: {
    name: 'stop_device',
    description: 'Stop running simulator or emulator',
    inputSchema: z.object({
      platform: z.enum(['ios', 'android']).optional().describe('Platform to stop. If not specified, stops all running devices.'),
    }),
  },
  install_app: {
    name: 'install_app',
    description: 'Install the Expo development client app on the device (requires Expo server to be running)',
    inputSchema: z.object({
      platform: z.enum(['ios', 'android']).describe('Platform to install on'),
    }),
  },
};

export function createLifecycleHandlers(managers: LifecycleTools) {
  return {
    async app_status() {
      const expoStatus = managers.expoManager.getStatus();

      let device: { platform: 'ios' | 'android' | null; name: string | null; udid: string | null } = {
        platform: null,
        name: null,
        udid: null,
      };

      // Check for booted iOS simulator
      try {
        const bootedSimulator = await managers.simulatorManager.getBootedDevice();
        if (bootedSimulator) {
          device = {
            platform: 'ios',
            name: bootedSimulator.name,
            udid: bootedSimulator.udid,
          };
        }
      } catch {
        // No simulator available
      }

      // If no iOS device, check for Android emulator
      if (!device.platform) {
        // Android emulator detection is less reliable, skip for now
        // Could enhance this by checking adb devices
      }

      const result = {
        expo_server: expoStatus,
        device,
        app_installed: false, // TODO: Implement app installation check
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
            text: JSON.stringify(result, null, 2),
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
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    async start_emulator(args: z.infer<typeof lifecycleToolSchemas.start_emulator.inputSchema>) {
      const deviceName = await managers.emulatorManager.start(args.device_name, {
        wait_for_boot: args.wait_for_boot,
        timeout_secs: args.timeout_secs,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ name: deviceName }, null, 2),
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
      // TODO: Implement app installation
      // This would involve building the app and installing it via xcrun simctl (iOS) or adb (Android)
      throw new Error('install_app not yet implemented. Use Expo Go or development client manually for now.');
    },
  };
}
