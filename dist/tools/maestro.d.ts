import { MaestroManager } from '../managers/maestro.js';
export interface MaestroToolsProxy {
    maestroManager: MaestroManager;
}
export declare function createMaestroToolsProxy(managers: MaestroToolsProxy): {
    getTools(): Promise<import("../managers/maestro.js").MaestroTool[]>;
    /**
     * Get current target device ID
     */
    getTargetDeviceId(): string | null;
    /**
     * Switch to a different device
     */
    switchDevice(deviceId: string): Promise<void>;
    /**
     * List all available devices
     */
    listDevices(): Promise<{
        device_id: string;
        name: string;
        platform: string;
        connected: boolean;
    }[]>;
    callTool(name: string, args: any): Promise<any>;
};
//# sourceMappingURL=maestro.d.ts.map