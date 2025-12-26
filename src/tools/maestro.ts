import { MaestroManager } from '../managers/maestro.js';
import { ExpoManager } from '../managers/expo.js';
import { processScreenshotResponse } from '../utils/image.js';

export interface MaestroToolsProxy {
  maestroManager: MaestroManager;
  expoManager: ExpoManager;
}

// Tools that return images and need resize processing
const SCREENSHOT_TOOLS = ['take_screenshot'];

// Tools that require device_id parameter
const DEVICE_REQUIRED_TOOLS = [
  'take_screenshot',
  'tap_on',
  'input_text',
  'back',
  'launch_app',
  'stop_app',
  'run_flow',
  'run_flow_files',
  'inspect_view_hierarchy',
];

export function createMaestroToolsProxy(managers: MaestroToolsProxy) {
  return {
    async getTools() {
      if (!managers.maestroManager.isReady()) {
        try {
          await managers.maestroManager.initialize();
        } catch (error) {
          console.error('[expo-mcp] Failed to initialize Maestro for tools list:', error);
          return [];
        }
      }

      const tools = managers.maestroManager.getTools();

      // Remove device_id from schemas - it's auto-injected from session
      return tools.map((tool) => {
        if (DEVICE_REQUIRED_TOOLS.includes(tool.name)) {
          const schema = { ...tool.inputSchema };
          if (schema.properties) {
            const { device_id, ...restProperties } = schema.properties;
            schema.properties = restProperties;
          }
          if (schema.required && Array.isArray(schema.required)) {
            schema.required = schema.required.filter((r: string) => r !== 'device_id');
          }
          return { ...tool, inputSchema: schema };
        }
        return tool;
      });
    },

    async callTool(name: string, args: any) {
      let enhancedArgs = { ...args };

      // Check for active session and inject device_id for device-required tools
      if (DEVICE_REQUIRED_TOOLS.includes(name)) {
        if (!managers.expoManager.hasActiveSession()) {
          throw new Error(
            'No active session. Call launch_expo first to establish a session.'
          );
        }

        const deviceId = managers.expoManager.getDeviceId();
        enhancedArgs = { ...args, device_id: deviceId };
      }

      const result = await managers.maestroManager.callTool(name, enhancedArgs);

      // Process screenshot responses to resize images if needed
      if (SCREENSHOT_TOOLS.includes(name)) {
        return await processScreenshotResponse(result);
      }

      return result;
    },
  };
}
