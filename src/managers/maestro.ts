import { spawn, ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';

export interface MaestroTool {
  name: string;
  description: string;
  inputSchema: any;
}

export interface MaestroToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class MaestroManager {
  private process: ChildProcess | null = null;
  private tools: Map<string, MaestroTool> = new Map();
  private requestId = 0;
  private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
  private readBuffer = '';
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const maestroPath = '/Users/dave/.maestro/bin/maestro';

    this.process = spawn(maestroPath, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.setEncoding('utf8');
    this.process.stdout?.on('data', (data) => {
      this.handleStdout(data);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[Maestro stderr] ${data.toString()}`);
    });

    this.process.on('exit', (code) => {
      console.error(`[Maestro] Process exited with code ${code}`);
      this.cleanup();
    });

    this.process.on('error', (error) => {
      console.error(`[Maestro] Process error:`, error);
      this.cleanup();
    });

    // Initialize connection (MCP protocol requires these fields)
    await this.sendRequest({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'expo-mcp',
          version: '0.2.0',
        },
      },
      id: this.requestId++,
    });

    // List tools
    const toolsResponse = await this.sendRequest({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: this.requestId++ });

    if (toolsResponse.tools) {
      for (const tool of toolsResponse.tools) {
        this.tools.set(tool.name, tool);
      }
    }

    this.isInitialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.process.kill('SIGTERM');
    await setTimeout(1000);

    if (this.process) {
      this.process.kill('SIGKILL');
    }

    this.cleanup();
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  getTools(): MaestroTool[] {
    return Array.from(this.tools.values());
  }

  async callTool(name: string, args: any): Promise<MaestroToolCallResult> {
    if (!this.isInitialized) {
      throw new Error('MaestroManager not initialized. Call initialize() first.');
    }

    if (!this.tools.has(name)) {
      throw new Error(`Tool "${name}" not found in Maestro MCP`);
    }

    const response = await this.sendRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
      id: this.requestId++,
    });

    return response.content || { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  private handleStdout(data: string): void {
    this.readBuffer += data;

    // Process complete JSON-RPC messages
    const lines = this.readBuffer.split('\n');
    this.readBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (error) {
        console.error('[Maestro] Failed to parse message:', line, error);
      }
    }
  }

  private handleMessage(message: any): void {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private sendRequest(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Maestro process not running'));
        return;
      }

      this.pendingRequests.set(request.id, { resolve, reject });

      const message = JSON.stringify(request) + '\n';
      this.process.stdin.write(message, (error) => {
        if (error) {
          this.pendingRequests.delete(request.id);
          reject(error);
        }
      });

      // Timeout after 30 seconds
      setTimeout(30000).then(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error('Request timeout'));
        }
      });
    });
  }

  private cleanup(): void {
    this.process = null;
    this.isInitialized = false;
    this.tools.clear();

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Maestro process terminated'));
    }
    this.pendingRequests.clear();
  }
}
