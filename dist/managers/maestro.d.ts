export interface MaestroTool {
    name: string;
    description: string;
    inputSchema: any;
}
export interface MaestroToolCallResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}
export declare class MaestroManager {
    private process;
    private tools;
    private requestId;
    private pendingRequests;
    private readBuffer;
    private isInitialized;
    private lastConnectedDevice;
    private consecutiveErrors;
    private static readonly MAX_CONSECUTIVE_ERRORS;
    private targetDeviceId;
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    /**
     * Restart Maestro MCP process (useful when switching devices)
     */
    restart(): Promise<void>;
    isReady(): boolean;
    getTools(): MaestroTool[];
    /**
     * Get the current target device ID
     */
    getTargetDeviceId(): string | null;
    /**
     * Set the target device ID for auto-injection into tool calls
     */
    setTargetDeviceId(deviceId: string | null): void;
    /**
     * Switch to a different device by updating the target device ID
     * Note: Maestro MCP doesn't require restart - each tool call takes device_id as argument
     */
    switchDevice(deviceId: string): Promise<void>;
    /**
     * Wait for a device to be connected with polling
     * @param timeoutMs Maximum time to wait in milliseconds
     * @param pollIntervalMs Interval between checks in milliseconds
     * @returns Connected device info or null if timeout
     */
    waitForDeviceConnection(timeoutMs?: number, pollIntervalMs?: number): Promise<{
        device_id: string;
        device_name: string;
        platform: string;
    } | null>;
    /**
     * Get the first connected device info and auto-set as target
     */
    getConnectedDevice(): Promise<{
        device_id: string;
        device_name: string;
        platform: string;
    } | null>;
    /**
     * Get all available devices (does NOT auto-set target device)
     */
    listDevices(): Promise<Array<{
        device_id: string;
        name: string;
        platform: string;
        connected: boolean;
    }>>;
    callTool(name: string, args: any, isRetry?: boolean): Promise<MaestroToolCallResult>;
    private handleStdout;
    private handleMessage;
    private sendRequest;
    private cleanup;
}
//# sourceMappingURL=maestro.d.ts.map