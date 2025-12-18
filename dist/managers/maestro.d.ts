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
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    /**
     * Restart Maestro MCP process (useful when switching devices)
     */
    restart(): Promise<void>;
    isReady(): boolean;
    getTools(): MaestroTool[];
    /**
     * Get the first connected device info
     */
    getConnectedDevice(): Promise<{
        device_id: string;
        device_name: string;
        platform: string;
    } | null>;
    callTool(name: string, args: any, isRetry?: boolean): Promise<MaestroToolCallResult>;
    private handleStdout;
    private handleMessage;
    private sendRequest;
    private cleanup;
}
//# sourceMappingURL=maestro.d.ts.map