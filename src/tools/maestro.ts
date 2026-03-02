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

/**
 * Static Maestro tool schemas — the final form exposed to Claude Code.
 *
 * Source version: 2.2.0 (see SCHEMA_SOURCE_VERSION in managers/maestro.ts).
 * If the installed Maestro CLI version falls outside the compatible range,
 * a warning is emitted at startup (see MaestroManager.initialize).
 *
 * These are based on the actual `maestro mcp` → `tools/list` response with:
 *   1. HIDDEN_TOOLS removed (launch_app, stop_app, start_device, cheat_sheet, query_docs)
 *   2. TOOL_RENAME_MAP applied (run_flow→run_maestro_flow, etc.)
 *   3. device_id stripped from DEVICE_REQUIRED_TOOLS schemas
 *   4. Description enhancements appended (REQUIRES_SESSION / "Can be called without an active session.")
 *
 * By defining these statically we avoid the need to initialize the Maestro CLI
 * process at tools/list time, which previously caused tools to be missing when
 * Maestro was unavailable at server startup.
 */
const MAESTRO_TOOL_SCHEMAS = [
  {
    name: 'list_devices',
    description:
      'List all available devices that can be launched for automation. Can be called without an active session.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: 'take_screenshot',
    description: `Take a screenshot of the current device screen ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {} as Record<string, any>,
      // device_id stripped (auto-injected)
    },
  },
  {
    name: 'tap_on',
    description: `Tap on a UI element by selector or description ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: "Text content to match (from 'text' field in inspect_ui output)",
        },
        id: {
          type: 'string',
          description: "Element ID to match (from 'id' field in inspect_ui output)",
        },
        index: {
          type: 'integer',
          description: '0-based index if multiple elements match the same criteria',
        },
        use_fuzzy_matching: {
          type: 'boolean',
          description:
            'Whether to use fuzzy/partial text matching (true, default) or exact regex matching (false)',
        },
        enabled: {
          type: 'boolean',
          description:
            'If true, only match enabled elements. If false, only match disabled elements. Omit this field to match regardless of enabled state.',
        },
        checked: {
          type: 'boolean',
          description:
            'If true, only match checked elements. If false, only match unchecked elements. Omit this field to match regardless of checked state.',
        },
        focused: {
          type: 'boolean',
          description:
            'If true, only match focused elements. If false, only match unfocused elements. Omit this field to match regardless of focus state.',
        },
        selected: {
          type: 'boolean',
          description:
            'If true, only match selected elements. If false, only match unselected elements. Omit this field to match regardless of selection state.',
        },
      },
      // device_id stripped (auto-injected); no required fields remain
    },
  },
  {
    name: 'input_text',
    description: `Input text into the currently focused text field ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to input' },
      },
      required: ['text'],
      // device_id stripped (auto-injected)
    },
  },
  {
    name: 'back',
    description: `Press the back button on the device ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {} as Record<string, any>,
      // device_id stripped (auto-injected)
    },
  },
  {
    name: 'run_maestro_flow',
    description:
      'Use this when interacting with a device and running adhoc commands, preferably one at a time.\n\n' +
      "Whenever you're exploring an app, testing out commands or debugging, prefer using this tool over creating temp files and using run_flow_files.\n\n" +
      'Run a set of Maestro commands (one or more). This can be a full maestro script (including headers), a set of commands (one per line) or simply a single command (eg \'- tapOn: 123\').\n\n' +
      'If this fails due to no device running, please ask the user to start a device!\n\n' +
      "If you don't have an up-to-date view hierarchy or screenshot on which to execute the commands, please call inspect_view_hierarchy first, instead of blindly guessing.\n\n" +
      "*** You don't need to call check_syntax before executing this, as syntax will be checked as part of the execution flow. ***\n\n" +
      'Use the `inspect_view_hierarchy` tool to retrieve the current view hierarchy and use it to execute commands on the device.\n' +
      "Use the `cheat_sheet` tool to retrieve a summary of Maestro's flow syntax before using any of the other tools.\n\n" +
      'Examples of valid inputs:\n```\n- tapOn: 123\n```\n\n```\nappId: any\n---\n- tapOn: 123\n```\n\n```\nappId: any\n# other headers here\n---\n- tapOn: 456\n- scroll\n# other commands here\n```' +
      ` ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {
        flow_yaml: {
          type: 'string',
          description: 'YAML-formatted Maestro flow content to execute',
        },
        env: {
          type: 'object',
          description:
            'Optional environment variables to inject into the flow (e.g., {"APP_ID": "com.example.app", "LANGUAGE": "en"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['flow_yaml'],
      // device_id stripped (auto-injected)
    },
  },
  {
    name: 'run_maestro_flow_files',
    description:
      "Run one or more full Maestro test files. If no device is running, you'll need to start a device first. " +
      `If the command fails using a relative path, try using an absolute path. ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {
        flow_files: {
          type: 'string',
          description:
            "Comma-separated file paths to YAML flow files to execute (e.g., 'flow1.yaml,flow2.yaml')",
        },
        env: {
          type: 'object',
          description:
            'Optional environment variables to inject into the flows (e.g., {"APP_ID": "com.example.app", "LANGUAGE": "tr", "COUNTRY": "TR"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['flow_files'],
      // device_id stripped (auto-injected)
    },
  },
  {
    name: 'check_maestro_flow_syntax',
    description:
      'Validates the syntax of a block of Maestro code. Valid maestro code must be well-formatted YAML. Can be called without an active session.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_yaml: {
          type: 'string',
          description: 'YAML-formatted Maestro flow content to validate',
        },
      },
      required: ['flow_yaml'],
    },
  },
  {
    name: 'inspect_view_hierarchy',
    description:
      'Get the nested view hierarchy of the current screen in CSV format. Returns UI elements with bounds coordinates for interaction. ' +
      'Use this to understand screen layout, find specific elements by text/id, or locate interactive components. ' +
      `Elements include bounds (x,y,width,height), text content, resource IDs, and interaction states (clickable, enabled, checked). ${REQUIRES_SESSION}`,
    inputSchema: {
      type: 'object',
      properties: {} as Record<string, any>,
      // device_id stripped (auto-injected)
    },
  },
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
    /** Return static tool schemas (no Maestro process needed). */
    getTools() {
      return MAESTRO_TOOL_SCHEMAS;
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
