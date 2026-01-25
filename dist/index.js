#!/usr/bin/env node

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// src/managers/expo.ts
import { spawn, execSync } from "child_process";
import { setTimeout } from "timers/promises";
import { networkInterfaces } from "os";
import { WebSocket } from "ws";
import * as net from "net";
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server2 = net.createServer();
    server2.once("error", () => resolve(false));
    server2.once("listening", () => {
      server2.close();
      resolve(true);
    });
    server2.listen(port);
  });
}
async function findAvailablePort(startPort, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`);
}
function getLanIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net2 of nets[name] ?? []) {
      if (net2.family === "IPv4" && !net2.internal) {
        return net2.address;
      }
    }
  }
  return "localhost";
}
var ExpoManager = class _ExpoManager {
  process = null;
  port = 8081;
  target = null;
  host = "lan";
  appDir;
  logBuffer = [];
  maxLogLines;
  deviceId = null;
  static EXPO_GO_MIN_STORAGE_MB = 300;
  // Expo Go APK is ~186MB, need extra for extraction
  static LOG_LEVEL_PRIORITY = {
    log: 0,
    info: 1,
    warn: 2,
    error: 3
  };
  constructor(appDir2) {
    this.appDir = appDir2 ?? process.env.EXPO_APP_DIR ?? process.cwd();
    this.maxLogLines = parseInt(process.env.LOG_BUFFER_SIZE || "400", 10);
  }
  /**
   * Get ADB path (tries common locations)
   */
  getAdbPath() {
    const commonPaths = [
      process.env.ANDROID_HOME && `${process.env.ANDROID_HOME}/platform-tools/adb`,
      `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`,
      "/usr/local/bin/adb",
      "adb"
      // Fallback to PATH
    ].filter(Boolean);
    for (const adbPath of commonPaths) {
      try {
        execSync(`${adbPath} version`, { stdio: "pipe" });
        return adbPath;
      } catch {
      }
    }
    return null;
  }
  /**
   * Get connected Android device ID
   */
  getConnectedAndroidDevice(adbPath) {
    try {
      const output = execSync(`${adbPath} devices`, { encoding: "utf8" });
      const lines = output.split("\n").slice(1);
      for (const line of lines) {
        const [deviceId, status] = line.trim().split(/\s+/);
        if (deviceId && status === "device") {
          return deviceId;
        }
      }
    } catch {
    }
    return null;
  }
  /**
   * Check available storage on Android device (in MB)
   */
  getAndroidAvailableStorage(adbPath, deviceId) {
    try {
      const output = execSync(`${adbPath} -s ${deviceId} shell df /data`, { encoding: "utf8" });
      const lines = output.trim().split("\n");
      if (lines.length >= 2) {
        const header = lines[0].toLowerCase();
        const parts = lines[1].split(/\s+/);
        const availStr = parts[3];
        if (availStr) {
          const is1KBlocks = header.includes("1k-block") || header.includes("1k block");
          const match = availStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT])?/i);
          if (match) {
            let value = parseFloat(match[1]);
            const unit = (match[2] || "").toUpperCase();
            if (unit === "K") {
              value /= 1024;
            } else if (unit === "M") {
            } else if (unit === "G") {
              value *= 1024;
            } else if (unit === "T") {
              value *= 1024 * 1024;
            } else if (!unit) {
              if (is1KBlocks) {
                value /= 1024;
              } else {
                value /= 1024 * 1024;
              }
            }
            return Math.floor(value);
          }
        }
      }
    } catch (error) {
      console.error("[Expo] Failed to check Android storage:", error);
    }
    return 0;
  }
  /**
   * Free up storage on Android device by clearing caches
   */
  async freeAndroidStorage(adbPath, deviceId) {
    console.error("[Expo] Attempting to free Android storage...");
    const commands = [
      // Clear package manager caches
      "pm trim-caches 999999999999",
      // Clear Google Play Services cache (often large)
      "pm clear com.google.android.gms 2>/dev/null || true",
      // Clear Chrome cache if installed
      "pm clear com.android.chrome 2>/dev/null || true",
      // Remove large pre-installed apps (user 0 only, recoverable)
      "pm uninstall -k --user 0 com.google.android.youtube 2>/dev/null || true",
      "pm uninstall -k --user 0 com.google.android.apps.maps 2>/dev/null || true",
      "pm uninstall -k --user 0 com.google.android.videos 2>/dev/null || true"
    ];
    for (const cmd of commands) {
      try {
        execSync(`${adbPath} -s ${deviceId} shell ${cmd}`, { stdio: "pipe" });
      } catch {
      }
    }
    console.error("[Expo] Storage cleanup completed");
  }
  /**
   * Ensure Android device has enough storage for Expo Go
   */
  async ensureAndroidStorage(adbPath, deviceId) {
    let availableMB = this.getAndroidAvailableStorage(adbPath, deviceId);
    console.error(`[Expo] Android available storage: ${availableMB}MB (need ${_ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB)`);
    if (availableMB < _ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
      console.error("[Expo] Insufficient storage, attempting cleanup...");
      await this.freeAndroidStorage(adbPath, deviceId);
      availableMB = this.getAndroidAvailableStorage(adbPath, deviceId);
      console.error(`[Expo] Android available storage after cleanup: ${availableMB}MB`);
      if (availableMB < _ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
        throw new Error(
          `Insufficient storage on Android device. Available: ${availableMB}MB, Required: ${_ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB. Please free up space manually or use an emulator with more storage.`
        );
      }
    }
  }
  async launch(options = {}) {
    const requestedPort = options.port ?? 8081;
    const target = options.target ?? null;
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;
    if (this.process) {
      throw new Error("Expo server is already running. Stop it first.");
    }
    const port = await findAvailablePort(requestedPort);
    if (port !== requestedPort) {
      console.error(`[Expo] Port ${requestedPort} in use, using port ${port} instead`);
    }
    if (target === "android-emulator") {
      const adbPath = this.getAdbPath();
      if (adbPath) {
        const deviceId = this.getConnectedAndroidDevice(adbPath);
        if (deviceId) {
          await this.ensureAndroidStorage(adbPath, deviceId);
        }
      }
    }
    this.port = port;
    this.target = target;
    const args = ["expo", "start", "--port", port.toString()];
    if (target === "ios-simulator") {
      args.push("--ios");
    } else if (target === "android-emulator") {
      args.push("--android");
    } else if (target === "web-browser") {
      args.push("--web");
    }
    let effectiveHost;
    if (options.host) {
      effectiveHost = options.host;
    } else if (target === "ios-simulator") {
      effectiveHost = "localhost";
    } else {
      effectiveHost = "lan";
    }
    this.host = effectiveHost;
    const shouldUseOffline = options.offline ?? process.env.CI === "1";
    if (shouldUseOffline) {
      args.push("--offline");
    } else if (effectiveHost === "tunnel") {
      args.push("--tunnel");
    } else if (effectiveHost === "lan") {
      args.push("--lan");
    } else if (effectiveHost === "localhost") {
      args.push("--localhost");
    }
    if (options.clear) {
      args.push("--clear");
    }
    if (options.dev === false) {
      args.push("--no-dev");
    }
    if (options.minify) {
      args.push("--minify");
    }
    if (options.max_workers !== void 0) {
      args.push("--max-workers", options.max_workers.toString());
    }
    if (options.scheme) {
      args.push("--scheme", options.scheme);
    }
    const env = { ...process.env, CI: "1" };
    this.process = spawn("npx", args, {
      cwd: this.appDir,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: true,
      shell: process.platform === "win32"
      // Only use shell on Windows
    });
    this.process.stdout?.on("data", (data) => {
      const text = data.toString();
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        this.logBuffer.push({
          timestamp: Date.now(),
          source: "stdout",
          level: this.parseLogLevel(line),
          message: line
        });
        if (this.logBuffer.length > this.maxLogLines) {
          this.logBuffer.shift();
        }
      }
      console.error(`[Expo stdout] ${text}`);
    });
    this.process.stderr?.on("data", (data) => {
      const text = data.toString();
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        this.logBuffer.push({
          timestamp: Date.now(),
          source: "stderr",
          level: this.parseLogLevel(line, "error"),
          message: line
        });
        if (this.logBuffer.length > this.maxLogLines) {
          this.logBuffer.shift();
        }
      }
      console.error(`[Expo stderr] ${text}`);
    });
    this.process.on("exit", (code) => {
      console.error(`[Expo] Process exited with code ${code}`);
      this.process = null;
    });
    if (waitForReady) {
      await this.waitForServer(port, timeoutSecs);
    }
    const hostname = effectiveHost === "localhost" ? "localhost" : getLanIP();
    const url = `http://${hostname}:${port}`;
    const exp_url = `exp://${hostname}:${port}`;
    return { url, exp_url, port, target, host: effectiveHost };
  }
  async stop() {
    if (!this.process || !this.process.pid) {
      return;
    }
    return new Promise((resolve) => {
      const proc = this.process;
      const pid = proc.pid;
      const cleanup = () => {
        this.process = null;
        this.target = null;
        this.host = "lan";
        this.deviceId = null;
        resolve();
      };
      proc.on("exit", cleanup);
      if (process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch (e) {
          proc.kill("SIGTERM");
        }
      } else {
        spawn("taskkill", ["/PID", pid.toString(), "/T", "/F"], {
          stdio: "ignore",
          shell: true
        });
        proc.kill("SIGTERM");
      }
      setTimeout(5e3).then(() => {
        if (this.process === proc) {
          console.error("[Expo] Force killing process group");
          if (process.platform !== "win32") {
            try {
              process.kill(-pid, "SIGKILL");
            } catch (e) {
              proc.kill("SIGKILL");
            }
          } else {
            proc.kill("SIGKILL");
          }
          cleanup();
        }
      });
    });
  }
  getStatus() {
    return this.process ? "running" : "stopped";
  }
  getPort() {
    return this.port;
  }
  getTarget() {
    return this.target;
  }
  getHost() {
    return this.host;
  }
  getDeviceId() {
    return this.deviceId;
  }
  setDeviceId(deviceId) {
    this.deviceId = deviceId;
  }
  hasActiveSession() {
    return this.process !== null && this.deviceId !== null;
  }
  /**
   * Reload the app on all connected devices via WebSocket message
   */
  async reload() {
    if (!this.process) {
      throw new Error("Expo server is not running");
    }
    const recentErrors = this.logBuffer.filter((log) => log.level === "error" && Date.now() - log.timestamp < 5e3).map((log) => log.message);
    if (recentErrors.some((msg) => /EADDRINUSE|port.*in use/i.test(msg))) {
      throw new Error("Port conflict detected. Stop other servers or use a different port.");
    }
    const wsUrl = `ws://localhost:${this.port}/message`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeoutId = global.setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connection timeout"));
      }, 5e3);
      ws.on("open", () => {
        const message = JSON.stringify({ version: 2, method: "reload" });
        ws.send(message);
        global.setTimeout(() => {
          clearTimeout(timeoutId);
          ws.close();
          resolve();
        }, 100);
      });
      ws.on("error", (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`WebSocket error: ${error.message}`));
      });
    });
  }
  /**
   * Parse log level from message content
   */
  parseLogLevel(line, defaultLevel = "log") {
    if (/\b(error|ERR!|ERROR)\b/i.test(line)) return "error";
    if (/\b(warn|warning|WARN)\b/i.test(line)) return "warn";
    if (/\b(info|INFO)\b/i.test(line)) return "info";
    return defaultLevel;
  }
  /**
   * Get captured logs with optional filtering
   */
  getLogs(options = {}) {
    const { limit, clear = false, level, source } = options;
    let logs = [...this.logBuffer];
    if (level) {
      const minPriority = _ExpoManager.LOG_LEVEL_PRIORITY[level];
      logs = logs.filter((l) => _ExpoManager.LOG_LEVEL_PRIORITY[l.level] >= minPriority);
    }
    if (source) {
      logs = logs.filter((l) => l.source === source);
    }
    if (limit) {
      logs = logs.slice(-limit);
    }
    if (clear) {
      this.logBuffer = [];
    }
    return logs;
  }
  async waitForServer(port, timeoutSecs) {
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1e3;
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`http://localhost:${port}/status`);
        if (response.ok) {
          return;
        }
      } catch {
      }
      await setTimeout(1e3);
    }
    throw new Error(`Expo server did not become ready within ${timeoutSecs} seconds`);
  }
};

// src/managers/maestro.ts
import { spawn as spawn2 } from "child_process";
import { setTimeout as setTimeout2 } from "timers/promises";
var MaestroManager = class _MaestroManager {
  process = null;
  tools = /* @__PURE__ */ new Map();
  requestId = 0;
  pendingRequests = /* @__PURE__ */ new Map();
  readBuffer = "";
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
    console.error("[Maestro] Starting Maestro MCP process...");
    const maestroPath = "/Users/dave/.maestro/bin/maestro";
    this.process = spawn2(maestroPath, ["mcp"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout?.setEncoding("utf8");
    this.process.stdout?.on("data", (data) => {
      this.handleStdout(data);
    });
    this.process.stderr?.on("data", (data) => {
      const str = data.toString();
      if (!str.includes("WARNING:")) {
        console.error(`[Maestro stderr] ${str}`);
      }
    });
    this.process.on("exit", (code) => {
      console.error(`[Maestro] Process exited with code ${code}`);
      this.cleanup();
    });
    this.process.on("error", (error) => {
      console.error(`[Maestro] Process error:`, error);
      this.cleanup();
    });
    console.error("[Maestro] Sending initialize request...");
    await this.sendRequest({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "expo-mcp",
          version: "0.2.0"
        }
      },
      id: this.requestId++
    });
    console.error("[Maestro] Initialize response received");
    console.error("[Maestro] Fetching tools list...");
    const toolsResponse = await this.sendRequest({ jsonrpc: "2.0", method: "tools/list", params: {}, id: this.requestId++ });
    if (toolsResponse.tools) {
      for (const tool of toolsResponse.tools) {
        this.tools.set(tool.name, tool);
      }
      console.error(`[Maestro] Loaded ${this.tools.size} tools`);
    }
    this.isInitialized = true;
    console.error("[Maestro] Initialization complete");
  }
  async shutdown() {
    if (!this.process) {
      return;
    }
    this.process.kill("SIGTERM");
    await setTimeout2(1e3);
    if (this.process) {
      this.process.kill("SIGKILL");
    }
    this.cleanup();
  }
  /**
   * Restart Maestro MCP process (useful when switching devices)
   */
  async restart() {
    console.error("[Maestro] Restarting Maestro MCP...");
    await this.shutdown();
    await setTimeout2(500);
    this.consecutiveErrors = 0;
    await this.initialize();
    console.error("[Maestro] Maestro MCP restarted successfully");
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
  async waitForDeviceConnection(timeoutMs = 3e4, pollIntervalMs = 1e3) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const device = await this.getConnectedDevice();
      if (device) {
        return device;
      }
      await setTimeout2(pollIntervalMs);
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
      } catch {
        return null;
      }
    }
    try {
      const result = await this.callTool("list_devices", {});
      const text = result.content?.[0]?.text;
      if (!text) return null;
      const data = JSON.parse(text);
      const devices = data.devices || [];
      const connected = devices.find((d) => d.connected === true);
      if (connected) {
        if (!this.targetDeviceId) {
          console.error(`[Maestro] Auto-setting target device: ${connected.device_id}`);
          this.targetDeviceId = connected.device_id;
        }
        return {
          device_id: connected.device_id,
          device_name: connected.name,
          platform: connected.platform
        };
      }
    } catch (error) {
      console.error("[Maestro] Failed to get connected device:", error);
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
      } catch {
        return [];
      }
    }
    try {
      const response = await this.sendRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "list_devices",
          arguments: {}
        },
        id: this.requestId++
      });
      const text = response.content?.[0]?.text;
      if (!text) return [];
      const data = JSON.parse(text);
      return data.devices || [];
    } catch (error) {
      console.error("[Maestro] Failed to list devices:", error);
      return [];
    }
  }
  async callTool(name, args, isRetry = false) {
    if (!this.isInitialized) {
      throw new Error("MaestroManager not initialized. Call initialize() first.");
    }
    if (!this.tools.has(name)) {
      throw new Error(`Tool "${name}" not found in Maestro MCP`);
    }
    try {
      const response = await this.sendRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name,
          arguments: args
        },
        id: this.requestId++
      });
      if (response.content?.[0]?.text) {
        const text = response.content[0].text;
        if (text.includes("UNAVAILABLE") || text.includes("io exception") || text.includes("grpc")) {
          throw new Error(text);
        }
      }
      this.consecutiveErrors = 0;
      if (response.content) {
        return response;
      }
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    } catch (error) {
      const errorMessage = error.message || String(error);
      if (errorMessage.includes("UNAVAILABLE") || errorMessage.includes("io exception") || errorMessage.includes("grpc")) {
        this.consecutiveErrors++;
        console.error(`[Maestro] Connection error (${this.consecutiveErrors}/${_MaestroManager.MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);
        if (!isRetry && this.consecutiveErrors >= _MaestroManager.MAX_CONSECUTIVE_ERRORS) {
          console.error("[Maestro] Too many consecutive errors, restarting Maestro...");
          await this.restart();
          return this.callTool(name, args, true);
        }
      }
      throw error;
    }
  }
  handleStdout(data) {
    this.readBuffer += data;
    const lines = this.readBuffer.split("\n");
    this.readBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (error) {
        console.error("[Maestro] Failed to parse message:", line, error);
      }
    }
  }
  handleMessage(message) {
    if (message.id !== void 0 && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }
  sendRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("Maestro process not running"));
        return;
      }
      this.pendingRequests.set(request.id, { resolve, reject });
      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message, (error) => {
        if (error) {
          this.pendingRequests.delete(request.id);
          reject(error);
        }
      });
      setTimeout2(3e4).then(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error("Request timeout"));
        }
      });
    });
  }
  cleanup() {
    this.process = null;
    this.isInitialized = false;
    this.tools.clear();
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error("Maestro process terminated"));
    }
    this.pendingRequests.clear();
  }
};

// src/tools/lifecycle.ts
import { z } from "zod";
var lifecycleToolSchemas = {
  app_status: {
    name: "app_status",
    description: "Get Expo server status and current session info",
    inputSchema: z.object({})
  },
  launch_expo: {
    name: "launch_expo",
    description: "Launch Expo dev server",
    inputSchema: z.object({
      // Target device (required)
      target: z.enum(["ios-simulator", "android-emulator", "web-browser"]).describe("Target platform to launch: ios-simulator, android-emulator, or web-browser"),
      // Session reconnection
      device_id: z.string().optional().describe("Device ID for session reconnection. Use the device_id returned from a previous launch_expo call."),
      // Connection mode
      host: z.enum(["lan", "tunnel", "localhost"]).optional().describe("Connection mode: lan (physical devices), tunnel (remote), localhost (simulator)"),
      offline: z.coerce.boolean().optional().describe("Offline mode"),
      // Server settings
      port: z.coerce.number().optional().describe("Server port (default: 8081)"),
      clear: z.coerce.boolean().optional().describe("Clear bundler cache"),
      // Build options
      dev: z.coerce.boolean().optional().describe("Development mode (default: true)"),
      minify: z.coerce.boolean().optional().describe("Minify JavaScript"),
      max_workers: z.coerce.number().optional().describe("Max Metro workers"),
      // Other
      scheme: z.string().optional().describe("Custom URI scheme"),
      // expo-mcp specific
      wait_for_ready: z.coerce.boolean().optional().describe("Wait for server ready"),
      timeout_secs: z.coerce.number().optional().describe("Timeout in seconds")
    })
  },
  stop_expo: {
    name: "stop_expo",
    description: "Stop Expo server",
    inputSchema: z.object({})
  },
  reload_expo: {
    name: "reload_expo",
    description: "Reload the Expo app on connected devices (triggers Metro bundler refresh)",
    inputSchema: z.object({})
  },
  get_logs: {
    name: "get_logs",
    description: "Get Metro bundler logs and console output from the running Expo app",
    inputSchema: z.object({
      limit: z.coerce.number().optional().describe("Maximum number of log lines to return (default: all)"),
      clear: z.coerce.boolean().optional().describe("Clear the log buffer after reading (default: false)"),
      level: z.enum(["log", "info", "warn", "error"]).optional().describe("Filter by minimum log level (log < info < warn < error)"),
      source: z.enum(["stdout", "stderr"]).optional().describe("Filter by output source")
    })
  }
};
function createLifecycleHandlers(managers) {
  return {
    async app_status() {
      const status = managers.expoManager.getStatus();
      const port = managers.expoManager.getPort();
      const target = managers.expoManager.getTarget();
      const host = managers.expoManager.getHost();
      const deviceId = managers.expoManager.getDeviceId();
      const hasSession = managers.expoManager.hasActiveSession();
      const result = {
        session_active: hasSession,
        expo_server: {
          status,
          port,
          target,
          host,
          url: status === "running" ? `http://localhost:${port}` : null,
          exp_url: status === "running" ? `exp://localhost:${port}` : null
        },
        device_id: deviceId
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    },
    async launch_expo(args) {
      const { device_id: requestedDeviceId, ...launchOptions } = args;
      if (requestedDeviceId && managers.expoManager.getStatus() === "running") {
        managers.expoManager.setDeviceId(requestedDeviceId);
        managers.maestroManager.setTargetDeviceId(requestedDeviceId);
        const port = managers.expoManager.getPort();
        const target = managers.expoManager.getTarget();
        const host = managers.expoManager.getHost();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "running",
                  port,
                  target,
                  host,
                  url: `http://localhost:${port}`,
                  exp_url: `exp://localhost:${port}`,
                  device_id: requestedDeviceId,
                  device_name: null,
                  platform: null,
                  message: `Session reconnected with device_id: ${requestedDeviceId}`
                },
                null,
                2
              )
            }
          ]
        };
      }
      const result = await managers.expoManager.launch(launchOptions);
      let device = null;
      if (result.target) {
        device = await managers.maestroManager.waitForDeviceConnection(3e4, 2e3);
        if (device) {
          managers.expoManager.setDeviceId(device.device_id);
          managers.maestroManager.setTargetDeviceId(device.device_id);
        } else {
          console.error(
            `[Expo] Warning: Could not detect device after launching ${result.target}. Maestro tools may not be available. Server will continue running.`
          );
        }
      }
      let message;
      if (result.target) {
        const targetName = result.target === "ios-simulator" ? "iOS Simulator" : result.target === "android-emulator" ? "Android Emulator" : "Web Browser";
        if (device) {
          message = `Expo server started. ${targetName} connected (${device.device_name}).`;
        } else {
          message = `Expo server started. ${targetName} launched but device detection failed. Maestro tools may not be available.`;
        }
      } else if (result.host === "tunnel") {
        message = "Expo server started with tunnel. Scan QR code in terminal or use exp_url in Expo Go.";
      } else if (result.host === "lan") {
        message = "Expo server started on LAN. Scan QR code in terminal or use exp_url in Expo Go.";
      } else {
        message = "Expo server started.";
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...result,
                device_id: device?.device_id ?? null,
                device_name: device?.device_name ?? null,
                platform: device?.platform ?? null,
                message
              },
              null,
              2
            )
          }
        ]
      };
    },
    async stop_expo() {
      await managers.expoManager.stop();
      return {
        content: [
          {
            type: "text",
            text: "Expo server stopped"
          }
        ]
      };
    },
    async reload_expo() {
      await managers.expoManager.reload();
      return {
        content: [
          {
            type: "text",
            text: "Reload command sent to connected devices"
          }
        ]
      };
    },
    async get_logs(args) {
      const logs = managers.expoManager.getLogs({
        limit: args.limit,
        clear: args.clear,
        level: args.level,
        source: args.source
      });
      if (logs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No logs available. Make sure Expo server is running."
            }
          ]
        };
      }
      const formatted = logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: formatted
          }
        ]
      };
    }
  };
}

// src/utils/image.ts
import sharp from "sharp";
var MAX_WIDTH = 1200;
var MAX_HEIGHT = 2e3;
var MAX_FILE_SIZE_BYTES = 200 * 1024;
async function resizeImageIfNeeded(base64Data, mimeType = "image/png") {
  try {
    let buffer = Buffer.from(base64Data, "base64");
    const originalSize = buffer.length;
    let image = sharp(buffer);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      console.error("[Image] Could not get image dimensions, returning original");
      return base64Data;
    }
    let { width, height } = metadata;
    const aspectRatio = width / height;
    let needsResize = width > MAX_WIDTH || height > MAX_HEIGHT;
    let newWidth = width;
    let newHeight = height;
    if (needsResize) {
      if (width > height) {
        newWidth = Math.min(width, MAX_WIDTH);
        newHeight = Math.round(newWidth / aspectRatio);
        if (newHeight > MAX_HEIGHT) {
          newHeight = MAX_HEIGHT;
          newWidth = Math.round(newHeight * aspectRatio);
        }
      } else {
        newHeight = Math.min(height, MAX_HEIGHT);
        newWidth = Math.round(newHeight * aspectRatio);
        if (newWidth > MAX_WIDTH) {
          newWidth = MAX_WIDTH;
          newHeight = Math.round(newWidth / aspectRatio);
        }
      }
    }
    let quality = 80;
    let resizedBuffer;
    do {
      image = sharp(buffer);
      resizedBuffer = await image.resize(newWidth, newHeight, {
        fit: "inside",
        withoutEnlargement: true
      }).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (resizedBuffer.length <= MAX_FILE_SIZE_BYTES) {
        break;
      }
      if (quality > 30) {
        quality -= 10;
        console.error(`[Image] Still too large (${(resizedBuffer.length / 1024).toFixed(1)}KB), reducing quality to ${quality}`);
      } else {
        newWidth = Math.round(newWidth * 0.8);
        newHeight = Math.round(newHeight * 0.8);
        quality = 70;
        console.error(`[Image] Still too large, reducing dimensions to ${newWidth}x${newHeight}`);
      }
    } while (resizedBuffer.length > MAX_FILE_SIZE_BYTES && newWidth > 200);
    const finalSize = resizedBuffer.length;
    console.error(`[Image] Resized from ${width}x${height} (${(originalSize / 1024).toFixed(1)}KB) to ${newWidth}x${newHeight} (${(finalSize / 1024).toFixed(1)}KB)`);
    return resizedBuffer.toString("base64");
  } catch (error) {
    console.error("[Image] Failed to resize image:", error);
    return base64Data;
  }
}
async function processScreenshotResponse(response) {
  if (!response?.content) {
    return response;
  }
  const processedContent = await Promise.all(
    response.content.map(async (item) => {
      if (item.type === "image" && item.source?.data) {
        const resizedData = await resizeImageIfNeeded(item.source.data, item.source.media_type);
        return {
          ...item,
          source: {
            ...item.source,
            data: resizedData,
            media_type: "image/jpeg"
            // Updated since we convert to JPEG
          }
        };
      }
      if (item.type === "image" && item.data) {
        const resizedData = await resizeImageIfNeeded(item.data, item.mimeType);
        return {
          ...item,
          data: resizedData,
          mimeType: "image/jpeg"
        };
      }
      return item;
    })
  );
  return {
    ...response,
    content: processedContent
  };
}

// src/tools/maestro.ts
var SCREENSHOT_TOOLS = ["take_screenshot"];
var DEVICE_REQUIRED_TOOLS = [
  "take_screenshot",
  "tap_on",
  "input_text",
  "back",
  "launch_app",
  "stop_app",
  "run_flow",
  "run_flow_files",
  "inspect_view_hierarchy"
];
function createMaestroToolsProxy(managers) {
  return {
    async getTools() {
      if (!managers.maestroManager.isReady()) {
        try {
          await managers.maestroManager.initialize();
        } catch (error) {
          console.error("[expo-mcp] Failed to initialize Maestro for tools list:", error);
          return [];
        }
      }
      const tools = managers.maestroManager.getTools();
      return tools.map((tool) => {
        if (DEVICE_REQUIRED_TOOLS.includes(tool.name)) {
          const schema = { ...tool.inputSchema };
          if (schema.properties) {
            const { device_id, ...restProperties } = schema.properties;
            schema.properties = restProperties;
          }
          if (schema.required && Array.isArray(schema.required)) {
            schema.required = schema.required.filter((r) => r !== "device_id");
          }
          return { ...tool, inputSchema: schema };
        }
        return tool;
      });
    },
    async callTool(name, args) {
      let enhancedArgs = { ...args };
      if (DEVICE_REQUIRED_TOOLS.includes(name)) {
        if (!managers.expoManager.hasActiveSession()) {
          throw new Error(
            "No active session. Call launch_expo first to establish a session."
          );
        }
        const deviceId = managers.expoManager.getDeviceId();
        enhancedArgs = { ...args, device_id: deviceId };
      }
      const result = await managers.maestroManager.callTool(name, enhancedArgs);
      if (SCREENSHOT_TOOLS.includes(name)) {
        return await processScreenshotResponse(result);
      }
      return result;
    }
  };
}

// src/server.ts
function getEssentialTools() {
  const envValue = process.env.ESSENTIAL_TOOLS;
  if (!envValue) return null;
  return new Set(envValue.split(",").map((t) => t.trim()).filter(Boolean));
}
var McpServer = class {
  server;
  expoManager;
  maestroManager;
  lifecycleHandlers;
  maestroProxy;
  constructor(appDir2) {
    this.server = new Server(
      {
        name: "expo-mcp",
        version: "0.2.0"
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );
    this.expoManager = new ExpoManager(appDir2);
    this.maestroManager = new MaestroManager();
    this.lifecycleHandlers = createLifecycleHandlers({
      expoManager: this.expoManager,
      maestroManager: this.maestroManager
    });
    this.maestroProxy = createMaestroToolsProxy({
      maestroManager: this.maestroManager,
      expoManager: this.expoManager
    });
    this.setupHandlers();
  }
  setupHandlers() {
    const essentialTools = getEssentialTools();
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allLifecycleTools = Object.values(lifecycleToolSchemas).map((schema) => {
        const properties = {};
        const required = [];
        if (schema.inputSchema.shape) {
          for (const [key, value] of Object.entries(schema.inputSchema.shape)) {
            const zodValue = value;
            properties[key] = {
              type: this.getZodType(zodValue),
              description: zodValue.description || ""
            };
            if (zodValue._def?.typeName === "ZodEnum") {
              properties[key].enum = zodValue._def.values;
            }
            if (!zodValue.isOptional()) {
              required.push(key);
            }
          }
        }
        return {
          name: schema.name,
          description: schema.description,
          inputSchema: {
            type: "object",
            properties,
            ...required.length > 0 && { required }
          }
        };
      });
      const allMaestroTools = (await this.maestroProxy.getTools()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));
      const allTools = [...allLifecycleTools, ...allMaestroTools];
      const filteredTools = essentialTools ? allTools.filter((tool) => essentialTools.has(tool.name)) : allTools;
      return {
        tools: filteredTools
      };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (name in lifecycleToolSchemas) {
        const handler = this.lifecycleHandlers[name];
        if (!handler) {
          throw new Error(`Handler not implemented for tool: ${name}`);
        }
        try {
          const schema = lifecycleToolSchemas[name];
          const validatedArgs = schema.inputSchema.parse(args || {});
          return await handler(validatedArgs);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error.message}`
              }
            ],
            isError: true
          };
        }
      }
      try {
        if (!this.maestroManager.isReady()) {
          console.error("[expo-mcp] Initializing Maestro MCP on first use...");
          await this.maestroManager.initialize();
          console.error("[expo-mcp] Maestro MCP initialized successfully");
        }
        return await this.maestroProxy.callTool(name, args || {});
      } catch (error) {
        if (error.message?.includes("Unknown tool")) {
          throw new Error(`Unknown tool: ${name}`);
        }
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }
  getZodType(zodSchema) {
    if (zodSchema._def?.typeName === "ZodString") return "string";
    if (zodSchema._def?.typeName === "ZodNumber") return "number";
    if (zodSchema._def?.typeName === "ZodBoolean") return "boolean";
    if (zodSchema._def?.typeName === "ZodEnum") return "string";
    if (zodSchema._def?.typeName === "ZodObject") return "object";
    if (zodSchema._def?.typeName === "ZodArray") return "array";
    return "string";
  }
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[expo-mcp] Server started on stdio");
  }
  async stop() {
    await this.expoManager.stop();
    await this.maestroManager.shutdown();
  }
};

// src/index.ts
var appDir = process.env.EXPO_APP_DIR || process.cwd();
var server = new McpServer(appDir);
process.on("SIGINT", async () => {
  console.error("[expo-mcp] Shutting down...");
  await server.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.error("[expo-mcp] Shutting down...");
  await server.stop();
  process.exit(0);
});
server.start().catch((error) => {
  console.error("[expo-mcp] Fatal error:", error);
  process.exit(1);
});
