import { MaestroManager } from '../managers/maestro.js';
import { InstanceRegistry } from '../registry/instance-registry.js';
import { processScreenshotResponse } from '../utils/image.js';

export interface MaestroToolsProxy {
  maestroManager: MaestroManager;
  registry: InstanceRegistry;
}

// Tools that return images and need resize processing
const SCREENSHOT_TOOLS = ['take_screenshot'];

// Tools that require a device (device_id is auto-injected from session)
const DEVICE_REQUIRED_TOOLS = [
  'take_screenshot',
  'tap_on',
  'input_text',
  'back',
  'run_flow',
  'run_flow_files',
  'inspect_view_hierarchy',
];

// Tools to hide from the MCP tools list (handled by lifecycle tools instead)
const HIDDEN_TOOLS = ['launch_app', 'stop_app'];

const REQUIRES_SESSION = 'Requires: start_session must be called first.';

// Fallback tool definitions shown before Maestro is initialized
const FALLBACK_MAESTRO_TOOLS = [
  { name: 'take_screenshot', description: `Take a screenshot of the device screen. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: {} } },
  { name: 'tap_on', description: `Tap on a UI element by text, id, or coordinates. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text of element to tap' }, id: { type: 'string', description: 'Accessibility ID of element to tap' }, point: { type: 'string', description: 'Coordinates to tap (e.g. "50%,50%")' } } } },
  { name: 'input_text', description: `Type text into the currently focused field. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to input' } }, required: ['text'] } },
  { name: 'back', description: `Press the back button. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: {} } },
  { name: 'run_flow', description: `Run a Maestro YAML flow. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { yaml: { type: 'string', description: 'YAML flow content' } }, required: ['yaml'] } },
  { name: 'run_flow_files', description: `Run Maestro flow files from the project directory. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Paths to Maestro flow files' } }, required: ['paths'] } },
  { name: 'inspect_view_hierarchy', description: `Get the UI element tree of the current screen. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: {} } },
  { name: 'list_devices', description: 'List all available devices (simulators and emulators). Can be called anytime.', inputSchema: { type: 'object', properties: {} } },
];

export function createMaestroToolsProxy(managers: MaestroToolsProxy) {
  /** Ensure Maestro is initialized and record its PID in the registry. */
  async function ensureInitialized(): Promise<void> {
    if (managers.maestroManager.isReady()) return;
    await managers.maestroManager.initialize();
    const pid = managers.maestroManager.getPid();
    if (pid) {
      managers.registry.update({ maestroPid: pid });
    }
  }

  return {
    async getTools() {
      try {
        await ensureInitialized();
      } catch (error) {
        console.error('[expo-mcp] Failed to initialize Maestro for tools list:', error);
        return FALLBACK_MAESTRO_TOOLS;
      }

      const tools = managers.maestroManager.getTools();

      return tools
        .filter((tool) => !HIDDEN_TOOLS.includes(tool.name))
        .map((tool) => {
          if (DEVICE_REQUIRED_TOOLS.includes(tool.name)) {
            // Remove device_id from schemas - it's auto-injected from session
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
      if (HIDDEN_TOOLS.includes(name)) {
        throw new Error(`Unknown tool: ${name}`);
      }

      await ensureInitialized();

      let enhancedArgs = { ...args };

      // Check for active session and inject device_id for device-required tools
      if (DEVICE_REQUIRED_TOOLS.includes(name)) {
        const state = managers.registry.getSessionState();

        if (state.status !== 'running') {
          throw new Error(
            'Session is not running. Call start_session first.'
          );
        }

        if (state.target === 'web-browser') {
          throw new Error(
            `"${name}" requires a native device. Not available for web-browser target.`
          );
        }

        if (!state.deviceId) {
          throw new Error(
            'Device lease expired. Call start_session to re-acquire the device.'
          );
        }

        enhancedArgs = { ...args, device_id: state.deviceId };
      }

      const result = await managers.maestroManager.callTool(name, enhancedArgs);

      // Auto-renew lease on successful device-required tool call
      if (DEVICE_REQUIRED_TOOLS.includes(name)) {
        managers.registry.touchLease();
      }

      // Process screenshot responses to resize images if needed
      if (SCREENSHOT_TOOLS.includes(name)) {
        return await processScreenshotResponse(result);
      }

      return result;
    },
  };
}
