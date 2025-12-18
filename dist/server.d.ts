export declare class McpServer {
    private server;
    private expoManager;
    private maestroManager;
    private lifecycleHandlers;
    private maestroProxy;
    constructor(appDir?: string);
    private setupHandlers;
    private getZodType;
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=server.d.ts.map