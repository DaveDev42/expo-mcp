import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';
export class MaestroManager {
    process = null;
    tools = new Map();
    requestId = 0;
    pendingRequests = new Map();
    readBuffer = '';
    isInitialized = false;
    lastConnectedDevice = null;
    consecutiveErrors = 0;
    static MAX_CONSECUTIVE_ERRORS = 2;
    // Current target device ID for auto-injection
    targetDeviceId = null;
    async initialize() {
        if (this.isInitialized) {
            return;
        }
        console.error('[Maestro] Starting Maestro MCP process...');
        const maestroPath = '/Users/dave/.maestro/bin/maestro';
        this.process = spawn(maestroPath, ['mcp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.process.stdout?.setEncoding('utf8');
        this.process.stdout?.on('data', (data) => {
            this.handleStdout(data);
        });
        this.process.stderr?.on('data', (data) => {
            const str = data.toString();
            // Only log non-warning messages
            if (!str.includes('WARNING:')) {
                console.error(`[Maestro stderr] ${str}`);
            }
        });
        this.process.on('exit', (code) => {
            console.error(`[Maestro] Process exited with code ${code}`);
            this.cleanup();
        });
        this.process.on('error', (error) => {
            console.error(`[Maestro] Process error:`, error);
            this.cleanup();
        });
        console.error('[Maestro] Sending initialize request...');
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
        console.error('[Maestro] Initialize response received');
        // List tools
        console.error('[Maestro] Fetching tools list...');
        const toolsResponse = await this.sendRequest({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: this.requestId++ });
        if (toolsResponse.tools) {
            for (const tool of toolsResponse.tools) {
                this.tools.set(tool.name, tool);
            }
            console.error(`[Maestro] Loaded ${this.tools.size} tools`);
        }
        this.isInitialized = true;
        console.error('[Maestro] Initialization complete');
    }
    async shutdown() {
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
    /**
     * Restart Maestro MCP process (useful when switching devices)
     */
    async restart() {
        console.error('[Maestro] Restarting Maestro MCP...');
        await this.shutdown();
        await setTimeout(500);
        this.consecutiveErrors = 0;
        await this.initialize();
        console.error('[Maestro] Maestro MCP restarted successfully');
    }
    isReady() {
        return this.isInitialized;
    }
    getTools() {
        return Array.from(this.tools.values());
    }
    /**
     * Get the current target device ID
     */
    getTargetDeviceId() {
        return this.targetDeviceId;
    }
    /**
     * Set the target device ID for auto-injection into tool calls
     */
    setTargetDeviceId(deviceId) {
        this.targetDeviceId = deviceId;
    }
    /**
     * Switch to a different device by updating the target device ID
     * Note: Maestro MCP doesn't require restart - each tool call takes device_id as argument
     */
    async switchDevice(deviceId) {
        console.error(`[Maestro] Switching target device to: ${deviceId}`);
        this.targetDeviceId = deviceId;
    }
    /**
     * Wait for a device to be connected with polling
     * @param timeoutMs Maximum time to wait in milliseconds
     * @param pollIntervalMs Interval between checks in milliseconds
     * @returns Connected device info or null if timeout
     */
    async waitForDeviceConnection(timeoutMs = 30000, pollIntervalMs = 1000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const device = await this.getConnectedDevice();
            if (device) {
                return device;
            }
            await setTimeout(pollIntervalMs);
        }
        return null;
    }
    /**
     * Get the first connected device info and auto-set as target
     */
    async getConnectedDevice() {
        if (!this.isInitialized) {
            try {
                await this.initialize();
            }
            catch {
                return null;
            }
        }
        try {
            const result = await this.callTool('list_devices', {});
            const text = result.content?.[0]?.text;
            if (!text)
                return null;
            const data = JSON.parse(text);
            const devices = data.devices || [];
            const connected = devices.find((d) => d.connected === true);
            if (connected) {
                // Auto-set as target device if not already set
                if (!this.targetDeviceId) {
                    console.error(`[Maestro] Auto-setting target device: ${connected.device_id}`);
                    this.targetDeviceId = connected.device_id;
                }
                return {
                    device_id: connected.device_id,
                    device_name: connected.name,
                    platform: connected.platform,
                };
            }
        }
        catch (error) {
            console.error('[Maestro] Failed to get connected device:', error);
        }
        return null;
    }
    /**
     * Get all available devices (does NOT auto-set target device)
     */
    async listDevices() {
        if (!this.isInitialized) {
            try {
                await this.initialize();
            }
            catch {
                return [];
            }
        }
        try {
            // Call list_devices directly without going through callTool
            // to avoid auto-setting target device
            const response = await this.sendRequest({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'list_devices',
                    arguments: {},
                },
                id: this.requestId++,
            });
            const text = response.content?.[0]?.text;
            if (!text)
                return [];
            const data = JSON.parse(text);
            return data.devices || [];
        }
        catch (error) {
            console.error('[Maestro] Failed to list devices:', error);
            return [];
        }
    }
    async callTool(name, args, isRetry = false) {
        if (!this.isInitialized) {
            throw new Error('MaestroManager not initialized. Call initialize() first.');
        }
        if (!this.tools.has(name)) {
            throw new Error(`Tool "${name}" not found in Maestro MCP`);
        }
        try {
            const response = await this.sendRequest({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name,
                    arguments: args,
                },
                id: this.requestId++,
            });
            // Check if response contains an error (Maestro returns errors in content)
            if (response.content?.[0]?.text) {
                const text = response.content[0].text;
                if (text.includes('UNAVAILABLE') || text.includes('io exception') || text.includes('grpc')) {
                    throw new Error(text);
                }
            }
            // Success - reset error counter
            this.consecutiveErrors = 0;
            if (response.content) {
                return response;
            }
            return { content: [{ type: 'text', text: JSON.stringify(response) }] };
        }
        catch (error) {
            const errorMessage = error.message || String(error);
            // Check if this is a device connection error
            if (errorMessage.includes('UNAVAILABLE') || errorMessage.includes('io exception') || errorMessage.includes('grpc')) {
                this.consecutiveErrors++;
                console.error(`[Maestro] Connection error (${this.consecutiveErrors}/${MaestroManager.MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);
                // Auto-restart on consecutive errors (device might have changed)
                if (!isRetry && this.consecutiveErrors >= MaestroManager.MAX_CONSECUTIVE_ERRORS) {
                    console.error('[Maestro] Too many consecutive errors, restarting Maestro...');
                    await this.restart();
                    // Retry once after restart
                    return this.callTool(name, args, true);
                }
            }
            throw error;
        }
    }
    handleStdout(data) {
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
            }
            catch (error) {
                console.error('[Maestro] Failed to parse message:', line, error);
            }
        }
    }
    handleMessage(message) {
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const pending = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
            }
            else {
                pending.resolve(message.result);
            }
        }
    }
    sendRequest(request) {
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
    cleanup() {
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
//# sourceMappingURL=maestro.js.map