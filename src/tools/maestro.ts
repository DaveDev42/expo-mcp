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
// NOTE: uses renamed tool names (after TOOL_RENAME_MAP is applied)
const DEVICE_REQUIRED_TOOLS = [
  'take_screenshot',
  'tap_on',
  'input_text',
  'back',
  'run_maestro_flow',
  'run_maestro_flow_files',
  'inspect_view_hierarchy',
];

// Tools to hide from the MCP tools list (handled by lifecycle tools or require API key)
const HIDDEN_TOOLS = ['launch_app', 'stop_app', 'start_device', 'cheat_sheet', 'query_docs'];

const REQUIRES_SESSION = 'Requires: start_session must be called first.';

// Rename map: Maestro original name → expo-mcp exposed name
const TOOL_RENAME_MAP: Record<string, string> = {
  run_flow: 'run_maestro_flow',
  run_flow_files: 'run_maestro_flow_files',
  check_flow_syntax: 'check_maestro_flow_syntax',
};
const REVERSE_RENAME_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_RENAME_MAP).map(([k, v]) => [v, k])
);

// Description enhancements for Maestro tools (keyed by renamed name)
const TOOL_DESCRIPTION_ENHANCEMENTS: Record<string, string> = {
  take_screenshot: REQUIRES_SESSION,
  tap_on: REQUIRES_SESSION,
  input_text: REQUIRES_SESSION,
  back: REQUIRES_SESSION,
  run_maestro_flow: REQUIRES_SESSION,
  run_maestro_flow_files: REQUIRES_SESSION,
  inspect_view_hierarchy: REQUIRES_SESSION,
  list_devices: 'Can be called without an active session.',
  check_maestro_flow_syntax: 'Can be called without an active session.',
};

// Fallback tool definitions shown before Maestro is initialized
// NOTE: uses renamed tool names (after TOOL_RENAME_MAP is applied)
const FALLBACK_MAESTRO_TOOLS = [
  { name: 'take_screenshot', description: `Take a screenshot of the device screen. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: {} } },
  { name: 'tap_on', description: `Tap on a UI element by text, id, or coordinates. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text of element to tap' }, id: { type: 'string', description: 'Accessibility ID of element to tap' }, point: { type: 'string', description: 'Coordinates to tap (e.g. "50%,50%")' } } } },
  { name: 'input_text', description: `Type text into the currently focused field. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to input' } }, required: ['text'] } },
  { name: 'back', description: `Press the back button. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: {} } },
  { name: 'run_maestro_flow', description: `Run a Maestro YAML flow. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { flow_yaml: { type: 'string', description: 'YAML flow content' } }, required: ['flow_yaml'] } },
  { name: 'run_maestro_flow_files', description: `Run Maestro flow files from the project directory. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Paths to Maestro flow files' } }, required: ['paths'] } },
  { name: 'check_maestro_flow_syntax', description: `Validate Maestro YAML flow syntax without running it. Can be called without an active session.`, inputSchema: { type: 'object', properties: { flow_yaml: { type: 'string', description: 'YAML flow content to validate' } }, required: ['flow_yaml'] } },
  { name: 'inspect_view_hierarchy', description: `Get the UI element tree of the current screen. ${REQUIRES_SESSION}`, inputSchema: { type: 'object', properties: {} } },
  { name: 'list_devices', description: 'List all available devices (simulators and emulators). Can be called without an active session.', inputSchema: { type: 'object', properties: {} } },
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
        // 1. Filter hidden tools (using Maestro original names)
        .filter((tool) => !HIDDEN_TOOLS.includes(tool.name))
        // 2. Rename tools
        .map((tool) => ({ ...tool, name: TOOL_RENAME_MAP[tool.name] ?? tool.name }))
        // 3. Strip device_id from device-required tools (using renamed names)
        .map((tool) => {
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
        })
        // 4. Enhance descriptions
        .map((tool) => {
          const enhancement = TOOL_DESCRIPTION_ENHANCEMENTS[tool.name];
          if (enhancement && !tool.description.includes(enhancement)) {
            return { ...tool, description: `${tool.description} ${enhancement}` };
          }
          return tool;
        });
    },

    async callTool(name: string, args: any) {
      // Reverse-rename: expo-mcp exposed name → Maestro original name
      const maestroName = REVERSE_RENAME_MAP[name] ?? name;

      if (HIDDEN_TOOLS.includes(maestroName)) {
        throw new Error(`Unknown tool: ${name}`);
      }

      await ensureInitialized();

      let enhancedArgs = { ...args };

      // Check for active session and inject device_id for device-required tools
      // (DEVICE_REQUIRED_TOOLS uses renamed names, so check against `name`)
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

      // Call Maestro with its original tool name
      const result = await managers.maestroManager.callTool(maestroName, enhancedArgs);

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
