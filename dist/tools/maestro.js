import { processScreenshotResponse } from '../utils/image.js';
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
        /**
         * Get current target device ID
         */
        getTargetDeviceId() {
            return managers.maestroManager.getTargetDeviceId();
        },
        /**
         * Switch to a different device
         */
        async switchDevice(deviceId) {
            await managers.maestroManager.switchDevice(deviceId);
        },
        /**
         * List all available devices
         */
        async listDevices() {
            return managers.maestroManager.listDevices();
        },
        async callTool(name, args) {
            // Auto-inject device_id if not provided and tool requires it
            let enhancedArgs = { ...args };
            if (DEVICE_REQUIRED_TOOLS.includes(name) && !args.device_id) {
                const targetDeviceId = managers.maestroManager.getTargetDeviceId();
                if (targetDeviceId) {
                    console.error(`[expo-mcp] Auto-injecting device_id: ${targetDeviceId} for tool: ${name}`);
                    enhancedArgs = { ...args, device_id: targetDeviceId };
                }
                else {
                    // Try to get connected device and set as target
                    const device = await managers.maestroManager.getConnectedDevice();
                    if (device) {
                        console.error(`[expo-mcp] Auto-detected device_id: ${device.device_id} for tool: ${name}`);
                        enhancedArgs = { ...args, device_id: device.device_id };
                    }
                }
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
//# sourceMappingURL=maestro.js.map