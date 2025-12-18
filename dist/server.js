import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { ExpoManager } from './managers/expo.js';
import { MaestroManager } from './managers/maestro.js';
import { lifecycleToolSchemas, createLifecycleHandlers } from './tools/lifecycle.js';
import { createMaestroToolsProxy } from './tools/maestro.js';
export class McpServer {
    server;
    expoManager;
    maestroManager;
    lifecycleHandlers;
    maestroProxy;
    constructor(appDir) {
        this.server = new Server({
            name: 'expo-mcp',
            version: '0.2.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        // Initialize managers
        this.expoManager = new ExpoManager(appDir);
        this.maestroManager = new MaestroManager();
        // Create handlers
        this.lifecycleHandlers = createLifecycleHandlers({
            expoManager: this.expoManager,
            maestroManager: this.maestroManager,
        });
        this.maestroProxy = createMaestroToolsProxy({
            maestroManager: this.maestroManager,
        });
        this.setupHandlers();
    }
    setupHandlers() {
        // List tools handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const lifecycleTools = Object.values(lifecycleToolSchemas).map((schema) => {
                const properties = {};
                if (schema.inputSchema.shape) {
                    for (const [key, value] of Object.entries(schema.inputSchema.shape)) {
                        const zodValue = value;
                        properties[key] = {
                            type: this.getZodType(zodValue),
                            description: zodValue.description || '',
                        };
                    }
                }
                return {
                    name: schema.name,
                    description: schema.description,
                    inputSchema: {
                        type: 'object',
                        properties,
                    },
                };
            });
            const maestroTools = (await this.maestroProxy.getTools()).map((tool) => ({
                name: `maestro_${tool.name}`,
                description: `[Maestro] ${tool.description}`,
                inputSchema: tool.inputSchema,
            }));
            return {
                tools: [...lifecycleTools, ...maestroTools],
            };
        });
        // Call tool handler
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            // Check if it's a lifecycle tool
            if (name in lifecycleToolSchemas) {
                const handler = this.lifecycleHandlers[name];
                if (!handler) {
                    throw new Error(`Handler not implemented for tool: ${name}`);
                }
                try {
                    return await handler(args || {});
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Error: ${error.message}`,
                            },
                        ],
                        isError: true,
                    };
                }
            }
            // Check if it's a maestro tool
            if (name.startsWith('maestro_')) {
                const maestroToolName = name.substring('maestro_'.length);
                try {
                    // Lazy initialize Maestro on first use
                    if (!this.maestroManager.isReady()) {
                        console.error('[expo-mcp] Initializing Maestro MCP on first use...');
                        await this.maestroManager.initialize();
                        console.error('[expo-mcp] Maestro MCP initialized successfully');
                    }
                    return await this.maestroProxy.callTool(maestroToolName, args || {});
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Error: ${error.message}`,
                            },
                        ],
                        isError: true,
                    };
                }
            }
            throw new Error(`Unknown tool: ${name}`);
        });
    }
    getZodType(zodSchema) {
        if (zodSchema._def?.typeName === 'ZodString')
            return 'string';
        if (zodSchema._def?.typeName === 'ZodNumber')
            return 'number';
        if (zodSchema._def?.typeName === 'ZodBoolean')
            return 'boolean';
        if (zodSchema._def?.typeName === 'ZodEnum')
            return 'string';
        if (zodSchema._def?.typeName === 'ZodObject')
            return 'object';
        if (zodSchema._def?.typeName === 'ZodArray')
            return 'array';
        return 'string';
    }
    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('[expo-mcp] Server started on stdio');
        // Maestro initializes lazily on first tool call
    }
    async stop() {
        await this.expoManager.stop();
        await this.maestroManager.shutdown();
    }
}
//# sourceMappingURL=server.js.map