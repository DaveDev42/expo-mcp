import { MaestroManager } from '../managers/maestro.js';
import { processScreenshotResponse } from '../utils/image.js';

export interface MaestroToolsProxy {
  maestroManager: MaestroManager;
}

// Tools that return images and need resize processing
const SCREENSHOT_TOOLS = ['take_screenshot'];

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
      return managers.maestroManager.getTools();
    },

    async callTool(name: string, args: any) {
      const result = await managers.maestroManager.callTool(name, args);

      // Process screenshot responses to resize images if needed
      if (SCREENSHOT_TOOLS.includes(name)) {
        return await processScreenshotResponse(result);
      }

      return result;
    },
  };
}
