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

// Fallback tool definitions when Maestro is not yet initialized
// These ensure tools are always listed in the MCP tools list
const FALLBACK_MAESTRO_TOOLS = [
  { name: 'take_screenshot', description: 'Take a screenshot of the device screen', inputSchema: { type: 'object', properties: {} } },
  { name: 'tap_on', description: 'Tap on a UI element by text, id, or coordinates', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text of element to tap' }, id: { type: 'string', description: 'Accessibility ID of element to tap' }, point: { type: 'string', description: 'Coordinates to tap (e.g. "50%,50%")' } } } },
  { name: 'input_text', description: 'Type text into the currently focused field', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to input' } }, required: ['text'] } },
  { name: 'back', description: 'Press the back button', inputSchema: { type: 'object', properties: {} } },
  { name: 'launch_app', description: 'Launch an app by bundle ID', inputSchema: { type: 'object', properties: { app_id: { type: 'string', description: 'Bundle ID of the app to launch' } }, required: ['app_id'] } },
  { name: 'stop_app', description: 'Stop an app by bundle ID', inputSchema: { type: 'object', properties: { app_id: { type: 'string', description: 'Bundle ID of the app to stop' } }, required: ['app_id'] } },
  { name: 'run_flow', description: 'Run a Maestro YAML flow', inputSchema: { type: 'object', properties: { yaml: { type: 'string', description: 'YAML flow content' } }, required: ['yaml'] } },
  { name: 'run_flow_files', description: 'Run Maestro flow files from the project directory', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Paths to Maestro flow files' } }, required: ['paths'] } },
  { name: 'inspect_view_hierarchy', description: 'Get the UI element tree of the current screen', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_devices', description: 'List all available devices', inputSchema: { type: 'object', properties: {} } },
];

export function createMaestroToolsProxy(managers: MaestroToolsProxy) {
  return {
    async getTools() {
      if (!managers.maestroManager.isReady()) {
        try {
          await managers.maestroManager.initialize();
        } catch (error) {
          console.error('[expo-mcp] Failed to initialize Maestro for tools list:', error);
          // Return fallback tools so they are always visible in the MCP tools list
          // Calling these tools will attempt to initialize Maestro on demand
          return FALLBACK_MAESTRO_TOOLS;
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
