import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { ExpoManager } from './managers/expo.js';
import { MaestroManager } from './managers/maestro.js';
import { lifecycleToolSchemas, createLifecycleHandlers } from './tools/lifecycle.js';
import { createMaestroToolsProxy } from './tools/maestro.js';
// Parse ESSENTIAL_TOOLS from environment
function getEssentialTools() {
    const envValue = process.env.ESSENTIAL_TOOLS;
    if (!envValue)
        return null; // null means show all tools
    return new Set(envValue.split(',').map((t) => t.trim()).filter(Boolean));
}
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
        // Get essential tools filter (null = show all)
        const essentialTools = getEssentialTools();
        // List tools handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const allLifecycleTools = Object.values(lifecycleToolSchemas).map((schema) => {
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
            const allMaestroTools = (await this.maestroProxy.getTools()).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            }));
            const allTools = [...allLifecycleTools, ...allMaestroTools];
            // Filter tools if ESSENTIAL_TOOLS is set
            const filteredTools = essentialTools
                ? allTools.filter((tool) => essentialTools.has(tool.name))
                : allTools;
            return {
                tools: filteredTools,
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
            // Try maestro tool (no prefix needed)
            try {
                // Lazy initialize Maestro on first use
                if (!this.maestroManager.isReady()) {
                    console.error('[expo-mcp] Initializing Maestro MCP on first use...');
                    await this.maestroManager.initialize();
                    console.error('[expo-mcp] Maestro MCP initialized successfully');
                }
                return await this.maestroProxy.callTool(name, args || {});
            }
            catch (error) {
                // If maestro doesn't have the tool, it's unknown
                if (error.message?.includes('Unknown tool')) {
                    throw new Error(`Unknown tool: ${name}`);
                }
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