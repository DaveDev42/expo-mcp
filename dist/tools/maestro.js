import { processScreenshotResponse } from '../utils/image.js';
// Tools that return images and need resize processing
const SCREENSHOT_TOOLS = ['take_screenshot'];
export function createMaestroToolsProxy(managers) {
    return {
        async getTools() {
            if (!managers.maestroManager.isReady()) {
                try {
                    await managers.maestroManager.initialize();
                }
                catch (error) {
                    console.error('[expo-mcp] Failed to initialize Maestro for tools list:', error);
                    return [];
                }
            }
            return managers.maestroManager.getTools();
        },
        async callTool(name, args) {
            const result = await managers.maestroManager.callTool(name, args);
            // Process screenshot responses to resize images if needed
            if (SCREENSHOT_TOOLS.includes(name)) {
                return await processScreenshotResponse(result);
            }
            return result;
        },
    };
}
//# sourceMappingURL=maestro.js.map