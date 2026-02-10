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

export interface ToolFilterConfig {
  essentialTools?: string;
  excludeTools?: string;
}

function createToolFilter(config?: ToolFilterConfig): (name: string) => boolean {
  if (config?.essentialTools) {
    const set = new Set(config.essentialTools.split(',').map((t) => t.trim()).filter(Boolean));
    return (name) => set.has(name);
  }
  if (config?.excludeTools) {
    const set = new Set(config.excludeTools.split(',').map((t) => t.trim()).filter(Boolean));
    return (name) => !set.has(name);
  }
  return () => true;
}

export class McpServer {
  private server: Server;
  private expoManager: ExpoManager;
  private maestroManager: MaestroManager;
  private lifecycleHandlers: ReturnType<typeof createLifecycleHandlers>;
  private maestroProxy: ReturnType<typeof createMaestroToolsProxy>;
  private toolFilterConfig?: ToolFilterConfig;

  constructor(appDir?: string, toolFilter?: ToolFilterConfig) {
    this.toolFilterConfig = toolFilter;
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
      maestroManager: this.maestroManager,
    });

    this.maestroProxy = createMaestroToolsProxy({
      maestroManager: this.maestroManager,
      expoManager: this.expoManager,
    });

    this.setupHandlers();
  }

  private setupHandlers() {
    const shouldInclude = createToolFilter(this.toolFilterConfig);

    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allLifecycleTools: Tool[] = Object.values(lifecycleToolSchemas).map((schema) => {
        const properties: Record<string, any> = {};
        const required: string[] = [];

        if (schema.inputSchema.shape) {
          for (const [key, value] of Object.entries(schema.inputSchema.shape)) {
            const zodValue = value as any;
            properties[key] = {
              type: this.getZodType(zodValue),
              description: zodValue.description || '',
            };
            // Add enum values if it's an enum type
            if (zodValue._def?.typeName === 'ZodEnum') {
              properties[key].enum = zodValue._def.values;
            }
            // Check if field is required (not optional)
            if (!zodValue.isOptional()) {
              required.push(key);
            }
          }
        }

        return {
          name: schema.name,
          description: schema.description,
          inputSchema: {
            type: 'object',
            properties,
            ...(required.length > 0 && { required }),
          },
        };
      });

      const allMaestroTools: Tool[] = (await this.maestroProxy.getTools()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      const allTools = [...allLifecycleTools, ...allMaestroTools];

      const filteredTools = allTools.filter((tool) => shouldInclude(tool.name));

      return {
        tools: filteredTools,
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
          // Validate args with zod schema
          const schema = lifecycleToolSchemas[name as keyof typeof lifecycleToolSchemas];
          const validatedArgs = schema.inputSchema.parse(args || {});
          return await (handler as any)(validatedArgs);
        } catch (error: any) {
          console.error(`[expo-mcp] Lifecycle tool error (${name}):`, error.message);
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

      // Try maestro tool (no prefix needed)
      try {
        // Lazy initialize Maestro on first use
        if (!this.maestroManager.isReady()) {
          console.error('[expo-mcp] Initializing Maestro MCP on first use...');
          await this.maestroManager.initialize();
          console.error('[expo-mcp] Maestro MCP initialized successfully');
        }
        return await this.maestroProxy.callTool(name, args || {});
      } catch (error: any) {
        // If maestro doesn't have the tool, it's unknown
        if (error.message?.includes('Unknown tool')) {
          throw new Error(`Unknown tool: ${name}`);
        }
        console.error(`[expo-mcp] Maestro tool error (${name}):`, error.message);
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
