import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { ExpoManager } from './managers/expo.js';
import { MaestroManager } from './managers/maestro.js';

import { lifecycleToolSchemas, createLifecycleHandlers } from './tools/lifecycle.js';
import { createMaestroToolsProxy } from './tools/maestro.js';

export class McpServer {
  private server: Server;
  private expoManager: ExpoManager;
  private maestroManager: MaestroManager;
  private lifecycleHandlers: ReturnType<typeof createLifecycleHandlers>;
  private maestroProxy: ReturnType<typeof createMaestroToolsProxy>;

  constructor(appDir?: string) {
    this.server = new Server(
      {
        name: 'expo-mcp',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize managers
    this.expoManager = new ExpoManager(appDir);
    this.maestroManager = new MaestroManager();

    // Create handlers
    this.lifecycleHandlers = createLifecycleHandlers({
      expoManager: this.expoManager,
    });

    this.maestroProxy = createMaestroToolsProxy({
      maestroManager: this.maestroManager,
    });

    this.setupHandlers();
  }

  private setupHandlers() {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const lifecycleTools: Tool[] = Object.values(lifecycleToolSchemas).map((schema) => {
        const properties: Record<string, any> = {};

        if (schema.inputSchema.shape) {
          for (const [key, value] of Object.entries(schema.inputSchema.shape)) {
            const zodValue = value as any;
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

      const maestroTools: Tool[] = this.maestroProxy.getTools().map((tool) => ({
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
        const handler = this.lifecycleHandlers[name as keyof typeof this.lifecycleHandlers];
        if (!handler) {
          throw new Error(`Handler not implemented for tool: ${name}`);
        }

        try {
          return await (handler as any)(args || {});
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text' as const,
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
          return await this.maestroProxy.callTool(maestroToolName, args || {});
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text' as const,
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

  private getZodType(zodSchema: any): string {
    if (zodSchema._def?.typeName === 'ZodString') return 'string';
    if (zodSchema._def?.typeName === 'ZodNumber') return 'number';
    if (zodSchema._def?.typeName === 'ZodBoolean') return 'boolean';
    if (zodSchema._def?.typeName === 'ZodEnum') return 'string';
    if (zodSchema._def?.typeName === 'ZodObject') return 'object';
    if (zodSchema._def?.typeName === 'ZodArray') return 'array';
    return 'string';
  }

  async start() {
    // Initialize Maestro MCP
    try {
      await this.maestroManager.initialize();
      console.error('[expo-mcp] Maestro MCP initialized successfully');
    } catch (error: any) {
      console.error('[expo-mcp] Failed to initialize Maestro MCP:', error.message);
      console.error('[expo-mcp] Maestro tools will not be available');
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[expo-mcp] Server started on stdio');
  }

  async stop() {
    await this.expoManager.stop();
    await this.maestroManager.shutdown();
  }
}
