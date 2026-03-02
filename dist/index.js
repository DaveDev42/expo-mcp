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
async function findAvailablePort(startPort, maxAttempts = 10, isPortClaimed) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (isPortClaimed && isPortClaimed(port)) {
      continue;
    }
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
  appDir;
  logBuffer = [];
  maxLogLines;
  sessionState;
  static EXPO_GO_MIN_STORAGE_MB = 300;
  // Expo Go APK is ~186MB, need extra for extraction
  static LOG_LEVEL_PRIORITY = {
    log: 0,
    info: 1,
    warn: 2,
    error: 3
  };
  constructor(sessionState, appDir2) {
    this.sessionState = sessionState;
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
        const [deviceId2, status] = line.trim().split(/\s+/);
        if (deviceId2 && status === "device") {
          return deviceId2;
        }
      }
    } catch {
    }
    return null;
  }
  /**
   * Check available storage on Android device (in MB)
   */
  getAndroidAvailableStorage(adbPath, deviceId2) {
    try {
      const output = execSync(`${adbPath} -s ${deviceId2} shell df /data`, { encoding: "utf8" });
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
  async freeAndroidStorage(adbPath, deviceId2) {
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
        execSync(`${adbPath} -s ${deviceId2} shell ${cmd}`, { stdio: "pipe" });
      } catch {
      }
    }
    console.error("[Expo] Storage cleanup completed");
  }
  /**
   * Ensure Android device has enough storage for Expo Go
   */
  async ensureAndroidStorage(adbPath, deviceId2) {
    let availableMB = this.getAndroidAvailableStorage(adbPath, deviceId2);
    console.error(`[Expo] Android available storage: ${availableMB}MB (need ${_ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB)`);
    if (availableMB < _ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
      console.error("[Expo] Insufficient storage, attempting cleanup...");
      await this.freeAndroidStorage(adbPath, deviceId2);
      availableMB = this.getAndroidAvailableStorage(adbPath, deviceId2);
      console.error(`[Expo] Android available storage after cleanup: ${availableMB}MB`);
      if (availableMB < _ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
        throw new Error(
          `Insufficient storage on Android device. Available: ${availableMB}MB, Required: ${_ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB. Please free up space manually or use an emulator with more storage.`
        );
      }
    }
  }
  /** iOS 시뮬레이터에 Expo Go 설치 여부 확인 */
  isExpoGoInstalledIOS() {
    const deviceId2 = this.sessionState.getSessionState().deviceId ?? "booted";
    try {
      const output = execSync(`xcrun simctl listapps ${deviceId2}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      return output.includes("host.exp.Exponent");
    } catch {
      return false;
    }
  }
  /** Android 에뮬레이터에 Expo Go 설치 여부 확인 */
  isExpoGoInstalledAndroid(adbPath) {
    const deviceId2 = this.sessionState.getSessionState().deviceId;
    const deviceFlag = deviceId2 ? `-s ${deviceId2} ` : "";
    try {
      const output = execSync(`${adbPath} ${deviceFlag}shell pm list packages host.exp.exponent`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      return output.includes("host.exp.exponent");
    } catch {
      return false;
    }
  }
  /** iOS 시뮬레이터 상태 정리 (키체인 리셋, Expo Go 종료) */
  cleanIOSSimulatorState() {
    const deviceId2 = this.sessionState.getSessionState().deviceId ?? "booted";
    console.error("[Expo] Cleaning iOS simulator state...");
    for (const cmd of [
      `xcrun simctl keychain ${deviceId2} reset`,
      `xcrun simctl terminate ${deviceId2} host.exp.Exponent`
    ]) {
      try {
        execSync(cmd, { stdio: "pipe", timeout: 1e4 });
      } catch {
      }
    }
  }
  /** Android 에뮬레이터 상태 정리 (Expo Go 앱 데이터 초기화) */
  cleanAndroidEmulatorState(adbPath) {
    const deviceId2 = this.sessionState.getSessionState().deviceId;
    const deviceFlag = deviceId2 ? `-s ${deviceId2} ` : "";
    console.error("[Expo] Cleaning Android emulator state...");
    try {
      execSync(`${adbPath} ${deviceFlag}shell pm clear host.exp.exponent`, { stdio: "pipe", timeout: 1e4 });
    } catch {
    }
  }
  /** iOS dev menu onboarding 억제 (UserDefaults 설정) */
  suppressDevMenuOnboardingIOS() {
    const deviceId2 = this.sessionState.getSessionState().deviceId ?? "booted";
    try {
      execSync(
        `xcrun simctl spawn ${deviceId2} defaults write host.exp.Exponent EXDevMenuIsOnboardingFinished -bool true`,
        { stdio: "pipe", timeout: 1e4 }
      );
      console.error("[Expo] iOS dev menu onboarding suppressed");
    } catch (e) {
      console.error(`[Expo] Failed to suppress iOS onboarding: ${e.message}`);
    }
  }
  /** Android dev menu onboarding 억제 (broadcast) */
  suppressDevMenuOnboardingAndroid() {
    const adbPath = this.getAdbPath();
    if (!adbPath) return;
    const deviceId2 = this.sessionState.getSessionState().deviceId;
    const deviceFlag = deviceId2 ? `-s ${deviceId2} ` : "";
    try {
      execSync(
        `${adbPath} ${deviceFlag}shell am broadcast -a expo.modules.devmenu.DISABLE_ONBOARDING`,
        { stdio: "pipe", timeout: 1e4 }
      );
      console.error("[Expo] Android dev menu onboarding suppressed");
    } catch (e) {
      console.error(`[Expo] Failed to suppress Android onboarding: ${e.message}`);
    }
  }
  /** 현재 타겟에 맞게 onboarding 억제 */
  suppressDevMenuOnboarding() {
    const target = this.sessionState.getSessionState().target;
    if (target === "ios-simulator") this.suppressDevMenuOnboardingIOS();
    else if (target === "android-emulator") this.suppressDevMenuOnboardingAndroid();
  }
  /** Metro 번들링 완료 대기 (로그 버퍼 감시) */
  async waitForBundleComplete(timeoutMs = 6e4) {
    const startTime = Date.now();
    const patterns = [/Bundled \d+ms/i, /Bundle complete/i, /Log box/i];
    while (Date.now() - startTime < timeoutMs) {
      const recent = this.logBuffer.filter((l) => l.timestamp > startTime);
      for (const log of recent) {
        if (patterns.some((p) => p.test(log.message))) {
          console.error(`[Expo] Bundle ready: ${log.message.substring(0, 80)}`);
          return true;
        }
      }
      await setTimeout(1e3);
    }
    console.error("[Expo] Bundle completion not detected within timeout");
    return false;
  }
  async launch(options = {}) {
    const requestedPort = options.port ?? 8081;
    const target = options.target ?? null;
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;
    if (this.process) {
      throw new Error("Expo server is already running. Stop it first.");
    }
    const port = await findAvailablePort(requestedPort, 10, options.isPortClaimed);
    if (port !== requestedPort) {
      console.error(`[Expo] Port ${requestedPort} in use, using port ${port} instead`);
    }
    if (target === "android-emulator") {
      const adbPath = this.getAdbPath();
      if (adbPath) {
        const deviceId2 = this.getConnectedAndroidDevice(adbPath);
        if (deviceId2) {
          await this.ensureAndroidStorage(adbPath, deviceId2);
        }
      }
    }
    if (target === "ios-simulator") {
      try {
        execSync("defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true", {
          stdio: "pipe",
          timeout: 5e3
        });
        console.error("[Expo] iOS simulator hardware keyboard enabled");
      } catch {
      }
    }
    if (options.clean_state) {
      if (target === "ios-simulator") this.cleanIOSSimulatorState();
      else if (target === "android-emulator") {
        const adbPath = this.getAdbPath();
        if (adbPath) this.cleanAndroidEmulatorState(adbPath);
      }
    }
    const args2 = ["expo", "start", "--port", port.toString()];
    if (target === "ios-simulator") {
      args2.push("--ios");
    } else if (target === "android-emulator") {
      args2.push("--android");
    } else if (target === "web-browser") {
      args2.push("--web");
    }
    if (target === "ios-simulator" && options.simulator_name) {
      args2.push("--device", options.simulator_name);
    }
    let effectiveHost;
    if (options.host) {
      effectiveHost = options.host;
    } else if (target === "ios-simulator") {
      effectiveHost = "localhost";
    } else {
      effectiveHost = "lan";
    }
    let shouldUseOffline = options.offline ?? true;
    if (shouldUseOffline && options.offline === void 0 && target) {
      let installed = true;
      if (target === "ios-simulator") {
        installed = this.isExpoGoInstalledIOS();
      } else if (target === "android-emulator") {
        const adbPath = this.getAdbPath();
        installed = adbPath ? this.isExpoGoInstalledAndroid(adbPath) : true;
      }
      if (!installed) {
        console.error("[Expo] Expo Go not installed. Disabling offline mode for installation.");
        shouldUseOffline = false;
      }
    }
    if (shouldUseOffline) {
      args2.push("--offline");
    } else if (effectiveHost === "tunnel") {
      args2.push("--tunnel");
    } else if (effectiveHost === "lan") {
      args2.push("--lan");
    } else if (effectiveHost === "localhost") {
      args2.push("--localhost");
    }
    if (options.clear) {
      args2.push("--clear");
    }
    if (options.dev === false) {
      args2.push("--no-dev");
    }
    if (options.minify) {
      args2.push("--minify");
    }
    if (options.max_workers !== void 0) {
      args2.push("--max-workers", options.max_workers.toString());
    }
    if (options.scheme) {
      args2.push("--scheme", options.scheme);
    }
    const env = { ...process.env };
    this.process = spawn("npx", args2, {
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
      let forceKillTimeout = null;
      const cleanup = () => {
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
          forceKillTimeout = null;
        }
        this.process = null;
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
      forceKillTimeout = global.setTimeout(() => {
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
      }, 5e3);
    });
  }
  getStatus() {
    return this.process ? "running" : "stopped";
  }
  getPort() {
    return this.sessionState.getSessionState().port;
  }
  getTarget() {
    return this.sessionState.getSessionState().target;
  }
  getHost() {
    return this.sessionState.getSessionState().host;
  }
  getDeviceId() {
    return this.sessionState.getSessionState().deviceId;
  }
  hasActiveSession() {
    const s = this.sessionState.getSessionState();
    return s.status === "running" && s.deviceId !== null;
  }
  /**
   * Reload the app on all connected devices via WebSocket message
   */
  async reload() {
    if (!this.process) {
      throw new Error("Expo server is not running");
    }
    const port = this.sessionState.getSessionState().port;
    if (!port) {
      throw new Error("No port available for reload");
    }
    const recentErrors = this.logBuffer.filter((log) => log.level === "error" && Date.now() - log.timestamp < 5e3).map((log) => log.message);
    if (recentErrors.some((msg) => /EADDRINUSE|port.*in use/i.test(msg))) {
      throw new Error("Port conflict detected. Stop other servers or use a different port.");
    }
    const wsUrl = `ws://localhost:${port}/message`;
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
import { setTimeout as sleep } from "timers/promises";
var MaestroManager = class _MaestroManager {
  process = null;
  tools = /* @__PURE__ */ new Map();
  requestId = 0;
  pendingRequests = /* @__PURE__ */ new Map();
  readBuffer = "";
  isInitialized = false;
  consecutiveErrors = 0;
  static MAX_CONSECUTIVE_ERRORS = 2;
  async initialize() {
    if (this.isInitialized) {
      return;
    }
    console.error("[Maestro] Starting Maestro MCP process...");
    const maestroPath = process.env.MAESTRO_CLI_PATH || `${process.env.HOME}/.maestro/bin/maestro`;
    this.process = spawn2(maestroPath, ["mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
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
    if (!this.process || !this.process.pid) {
      return;
    }
    const proc = this.process;
    const pid = proc.pid;
    return new Promise((resolve) => {
      let settled = false;
      let forceKillTimeout = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        this.cleanup();
        resolve();
      };
      proc.on("exit", settle);
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
        }
      }
      forceKillTimeout = global.setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
          }
        }
        settle();
      }, 3e3);
    });
  }
  /**
   * Restart Maestro MCP process (useful when switching devices)
   */
  async restart() {
    console.error("[Maestro] Restarting Maestro MCP...");
    await this.shutdown();
    await sleep(500);
    this.consecutiveErrors = 0;
    await this.initialize();
    console.error("[Maestro] Maestro MCP restarted successfully");
  }
  isReady() {
    return this.isInitialized;
  }
  getPid() {
    return this.process?.pid ?? null;
  }
  getTools() {
    return Array.from(this.tools.values());
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
      await sleep(pollIntervalMs);
    }
    return null;
  }
  /**
   * Get the first connected device info
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
  /** 디바이스와 실제 상호작용 가능 여부 확인 */
  async verifyDeviceReady(deviceId2, maxAttempts = 3) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.callTool("inspect_view_hierarchy", { device_id: deviceId2 });
        if (result.content?.[0]?.text && !result.isError) {
          console.error("[Maestro] Device readiness verified");
          return true;
        }
      } catch {
        console.error(`[Maestro] Readiness probe ${i + 1}/${maxAttempts} failed`);
      }
      await sleep(2e3);
    }
    return false;
  }
  async callTool(name, args2, isRetry = false) {
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
          arguments: args2
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
          return this.callTool(name, args2, true);
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
      clearTimeout(pending.timeoutId);
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
      const timeoutId = global.setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error("Request timeout"));
        }
      }, 3e4);
      this.pendingRequests.set(request.id, { resolve, reject, timeoutId });
      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message, (error) => {
        if (error) {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(request.id);
          reject(error);
        }
      });
    });
  }
  cleanup() {
    this.process = null;
    this.isInitialized = false;
    this.tools.clear();
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Maestro process terminated"));
    }
    this.pendingRequests.clear();
  }
};

// src/registry/instance-registry.ts
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
function isValidDeviceId(id) {
  return /^[a-zA-Z0-9._:-]+$/.test(id);
}
var InstanceRegistry = class {
  instanceId;
  dir;
  filePath;
  constructor() {
    this.instanceId = randomUUID();
    this.dir = join(tmpdir(), "expo-mcp", "instances");
    this.filePath = join(this.dir, `${this.instanceId}.json`);
  }
  register(appDir2) {
    mkdirSync(this.dir, { recursive: true });
    const record = {
      instanceId: this.instanceId,
      pid: process.pid,
      appDir: appDir2,
      port: null,
      target: null,
      host: "lan",
      deviceId: null,
      deviceName: null,
      platform: null,
      maestroPid: null,
      status: "stopped",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      deviceLeasedAt: null,
      deviceLeaseExpiresAt: null,
      deviceLeaseTtlMs: null
    };
    writeFileSync(this.filePath, JSON.stringify(record), "utf8");
  }
  update(fields) {
    if (fields.deviceId != null && !isValidDeviceId(fields.deviceId)) {
      throw new Error(`Invalid device ID format: ${fields.deviceId}`);
    }
    const record = this.get();
    if (!record) return;
    const updated = { ...record, ...fields, updatedAt: Date.now() };
    writeFileSync(this.filePath, JSON.stringify(updated), "utf8");
  }
  get() {
    try {
      const data = readFileSync(this.filePath, "utf8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  deregister() {
    try {
      unlinkSync(this.filePath);
    } catch {
    }
  }
  getSessionState() {
    const record = this.get();
    if (!record) {
      return { port: null, target: null, host: "lan", deviceId: null, status: "stopped" };
    }
    if (record.deviceId && record.deviceLeaseExpiresAt && Date.now() > record.deviceLeaseExpiresAt) {
      this.update({
        deviceId: null,
        deviceName: null,
        platform: null,
        deviceLeasedAt: null,
        deviceLeaseExpiresAt: null,
        deviceLeaseTtlMs: null
      });
      return {
        port: record.port,
        target: record.target,
        host: record.host,
        deviceId: null,
        status: record.status
      };
    }
    return {
      port: record.port,
      target: record.target,
      host: record.host,
      deviceId: record.deviceId,
      status: record.status
    };
  }
  getInstanceId() {
    return this.instanceId;
  }
  // --- Cross-instance queries ---
  listAll() {
    if (!existsSync(this.dir)) return [];
    const records = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = readFileSync(join(this.dir, file), "utf8");
        const record = JSON.parse(data);
        if (!this.isProcessAlive(record.pid)) {
          try {
            unlinkSync(join(this.dir, file));
          } catch {
          }
          continue;
        }
        records.push(record);
      } catch {
      }
    }
    return records;
  }
  isPortClaimed(port) {
    return this.listAll().some(
      (r) => r.instanceId !== this.instanceId && r.port === port && r.status !== "stopped"
    );
  }
  isDeviceClaimed(deviceId2) {
    const match = this.listAll().find(
      (r) => r.instanceId !== this.instanceId && r.deviceId === deviceId2 && r.status !== "stopped"
    );
    if (!match) return null;
    if (match.deviceLeaseExpiresAt && Date.now() > match.deviceLeaseExpiresAt) {
      this.evictExpiredLease(match);
      return null;
    }
    return match;
  }
  getClaimedDeviceIds() {
    return this.listAll().filter((r) => {
      if (r.instanceId === this.instanceId || !r.deviceId || r.status === "stopped") return false;
      if (r.deviceLeaseExpiresAt && Date.now() > r.deviceLeaseExpiresAt) {
        this.evictExpiredLease(r);
        return false;
      }
      return true;
    }).map((r) => r.deviceId);
  }
  touchLease() {
    const record = this.get();
    if (!record?.deviceId || !record.deviceLeaseTtlMs) return;
    this.update({
      deviceLeaseExpiresAt: Date.now() + record.deviceLeaseTtlMs
    });
  }
  evictExpiredLease(record) {
    try {
      const filePath = join(this.dir, `${record.instanceId}.json`);
      const data = readFileSync(filePath, "utf8");
      const current = JSON.parse(data);
      const updated = {
        ...current,
        deviceId: null,
        deviceName: null,
        platform: null,
        deviceLeasedAt: null,
        deviceLeaseExpiresAt: null,
        deviceLeaseTtlMs: null,
        updatedAt: Date.now()
      };
      writeFileSync(filePath, JSON.stringify(updated), "utf8");
    } catch {
    }
  }
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
};

// src/utils/process-cleanup.ts
import { execSync as execSync2 } from "child_process";
function cleanupOrphanedMaestroProcesses() {
  if (process.platform === "win32") return;
  try {
    const output = execSync2('pgrep -af "maestro mcp$"', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    for (const line of output.trim().split("\n")) {
      if (!line.trim()) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (isNaN(pid) || pid === process.pid) continue;
      try {
        const ppidOutput = execSync2(`ps -o ppid= -p ${pid}`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"]
        });
        const ppid = parseInt(ppidOutput.trim(), 10);
        if (ppid === 1) {
          console.error(`[cleanup] Killing orphaned Maestro process: PID ${pid}`);
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
            }
          }
        }
      } catch {
      }
    }
  } catch {
  }
}

// src/tools/lifecycle.ts
import { z } from "zod";
var DEFAULT_LEASE_TTL_MS = 2 * 6e4;
function requireNativeDevice(registry, toolName) {
  const state = registry.getSessionState();
  if (state.status !== "running") {
    throw new Error("Session is not running. Call start_session first.");
  }
  if (state.target === "web-browser") {
    throw new Error(`"${toolName}" requires a native device.`);
  }
  if (!state.deviceId) {
    throw new Error("Device lease expired. Call start_session to re-acquire.");
  }
  return { deviceId: state.deviceId };
}
var lifecycleToolSchemas = {
  get_session_status: {
    name: "get_session_status",
    description: "Get current session status including server state, connected device, and device lease. Call this first to understand the current state before using other tools.",
    inputSchema: z.object({})
  },
  start_session: {
    name: "start_session",
    description: "Start a session: launches the Expo dev server, connects to a device, and acquires a device lease. The device lease is automatically renewed on every device tool call (take_screenshot, tap_on, etc). If the lease expires after 2 minutes of inactivity, call start_session again to reconnect. If the server is already running, this re-acquires the device lease without restarting.",
    inputSchema: z.object({
      target: z.enum(["ios-simulator", "android-emulator", "web-browser"]).describe("Target platform to launch: ios-simulator, android-emulator, or web-browser"),
      device_id: z.string().optional().describe(
        "Specific device to use (iOS simulator UUID or Android emulator serial like emulator-5554). If omitted, the first available connected device is used automatically."
      ),
      host: z.enum(["lan", "tunnel", "localhost"]).optional().describe("Connection mode: lan (physical devices), tunnel (remote), localhost (simulator)"),
      offline: z.coerce.boolean().optional().describe("Offline mode"),
      port: z.coerce.number().optional().describe("Server port (default: 8081)"),
      clear: z.coerce.boolean().optional().describe("Clear bundler cache"),
      dev: z.coerce.boolean().optional().describe("Development mode (default: true)"),
      minify: z.coerce.boolean().optional().describe("Minify JavaScript"),
      max_workers: z.coerce.number().optional().describe("Max Metro workers"),
      scheme: z.string().optional().describe("Custom URI scheme"),
      simulator_name: z.string().optional().describe('iOS simulator name (e.g., "iPhone 16 Pro"). Only for ios-simulator target.'),
      clean_state: z.coerce.boolean().optional().describe("Clean simulator state before launch (reset keychain, clear app data). Default: false"),
      skip_dev_menu_onboarding: z.coerce.boolean().optional().describe("Skip Expo Go dev menu onboarding (default: true)"),
      auto_login: z.object({
        flow_file: z.string().describe(
          "Path to a Maestro YAML flow file to run after app loads. Env vars like EXPO_TEST_PHONE are available as ${EXPO_TEST_PHONE} in the flow."
        )
      }).optional().describe("Run a Maestro flow after app loads"),
      wait_for_ready: z.coerce.boolean().optional().describe("Wait for server ready"),
      timeout_secs: z.coerce.number().optional().describe("Timeout in seconds")
    })
  },
  stop_session: {
    name: "stop_session",
    description: "Stop the session: shuts down the Expo dev server, releases the device, and cleans up all resources. Requires: session must be running (call start_session first).",
    inputSchema: z.object({})
  },
  reload_app: {
    name: "reload_app",
    description: "Reload the app on the connected device (triggers Metro bundler refresh). Requires: session must be running (call start_session first).",
    inputSchema: z.object({})
  },
  get_logs: {
    name: "get_logs",
    description: "Get Metro bundler logs and console output from the running app. Requires: session must be running (call start_session first).",
    inputSchema: z.object({
      limit: z.coerce.number().optional().describe("Maximum number of log lines to return (default: all)"),
      clear: z.coerce.boolean().optional().describe("Clear the log buffer after reading (default: false)"),
      level: z.enum(["log", "info", "warn", "error"]).optional().describe("Filter by minimum log level (log < info < warn < error)"),
      source: z.enum(["stdout", "stderr"]).optional().describe("Filter by output source")
    })
  },
  press_key: {
    name: "press_key",
    description: "Press a key on the device. For text input use input_text instead. Requires: start_session must be called first.",
    inputSchema: z.object({
      key: z.enum(["Enter", "Backspace", "Home", "Lock", "Tab", "Volume Up", "Volume Down"]).describe("The key to press")
    })
  },
  scroll: {
    name: "scroll",
    description: "Scroll the screen. Requires: start_session must be called first.",
    inputSchema: z.object({
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction (default: down)")
    })
  },
  swipe: {
    name: "swipe",
    description: "Swipe on the screen. Use direction for simple swipes, or start+end for precise control. Requires: start_session must be called first.",
    inputSchema: z.object({
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("Swipe direction (simple mode)"),
      start: z.string().optional().describe('Start point "x%,y%" (precise mode, use with end)'),
      end: z.string().optional().describe('End point "x%,y%" (precise mode, use with start)'),
      duration: z.coerce.number().optional().describe("Duration in ms (default: 400)")
    })
  }
};
function createLifecycleHandlers(managers) {
  const { registry } = managers;
  return {
    async get_session_status() {
      const state = registry.getSessionState();
      const record = registry.get();
      const status = managers.expoManager.getStatus();
      let deviceLease = null;
      if (record?.deviceLeaseExpiresAt && record.deviceLeaseTtlMs && state.deviceId) {
        const remaining = Math.max(0, record.deviceLeaseExpiresAt - Date.now());
        deviceLease = {
          ttl_minutes: record.deviceLeaseTtlMs / 6e4,
          remaining_seconds: Math.round(remaining / 1e3)
        };
      }
      const result = {
        session_active: state.status === "running" && (state.deviceId !== null || state.target === "web-browser"),
        server: {
          status,
          port: state.port,
          target: state.target,
          host: state.host,
          url: status === "running" && state.port ? `http://localhost:${state.port}` : null
        },
        device: state.deviceId ? { device_id: state.deviceId, device_name: record?.deviceName ?? null, platform: record?.platform ?? null, lease: deviceLease } : null,
        instance_id: record?.instanceId ?? null
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
    async start_session(args2) {
      const { device_id: requestedDeviceId, ...launchOptions } = args2;
      if (managers.expoManager.getStatus() === "running") {
        let deviceId2 = requestedDeviceId;
        let detectedDevice = null;
        if (!deviceId2) {
          detectedDevice = await managers.maestroManager.waitForDeviceConnection(1e4, 2e3);
          if (!detectedDevice) {
            throw new Error(
              "Server is already running but no connected device found. Provide a device_id or call stop_session first."
            );
          }
          deviceId2 = detectedDevice.device_id;
        }
        const claimer = registry.isDeviceClaimed(deviceId2);
        if (claimer) {
          throw new Error(
            `Device ${deviceId2} is in use by another instance (PID ${claimer.pid}, ${claimer.appDir}). Use list_devices to find available devices, or stop that instance first.`
          );
        }
        const now = Date.now();
        registry.update({
          deviceId: deviceId2,
          deviceName: detectedDevice?.device_name ?? null,
          platform: detectedDevice?.platform ?? null,
          deviceLeasedAt: now,
          deviceLeaseExpiresAt: now + DEFAULT_LEASE_TTL_MS,
          deviceLeaseTtlMs: DEFAULT_LEASE_TTL_MS
        });
        const state = registry.getSessionState();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "running",
                  port: state.port,
                  target: state.target,
                  host: state.host,
                  device_id: deviceId2,
                  message: "Device lease renewed. Server was already running."
                },
                null,
                2
              )
            }
          ]
        };
      }
      if (requestedDeviceId) {
        const claimer = registry.isDeviceClaimed(requestedDeviceId);
        if (claimer) {
          const claimedIds = registry.getClaimedDeviceIds();
          throw new Error(
            `Device ${requestedDeviceId} is in use by another instance (PID ${claimer.pid}, ${claimer.appDir}). Claimed devices: ${claimedIds.join(", ") || "none"}. Use list_devices to find available devices.`
          );
        }
      }
      registry.update({
        status: "starting",
        port: launchOptions.port ?? 8081,
        target: launchOptions.target,
        host: launchOptions.host ?? (launchOptions.target === "ios-simulator" ? "localhost" : "lan")
      });
      let result;
      try {
        result = await managers.expoManager.launch({
          ...launchOptions,
          isPortClaimed: (port) => registry.isPortClaimed(port)
        });
      } catch (err) {
        registry.update({ status: "stopped", port: null, target: null });
        throw err;
      }
      registry.update({
        status: "running",
        port: result.port,
        target: result.target,
        host: result.host
      });
      let device = null;
      if (result.target && result.target !== "web-browser") {
        device = await managers.maestroManager.waitForDeviceConnection(3e4, 2e3);
        if (device) {
          const now = Date.now();
          registry.update({
            deviceId: device.device_id,
            deviceName: device.device_name,
            platform: device.platform,
            deviceLeasedAt: now,
            deviceLeaseExpiresAt: now + DEFAULT_LEASE_TTL_MS,
            deviceLeaseTtlMs: DEFAULT_LEASE_TTL_MS
          });
        } else {
          console.error(
            `[expo-mcp] Warning: Could not detect device after launching ${result.target}. Device tools may not work. Server will continue running.`
          );
        }
      }
      if ((args2.skip_dev_menu_onboarding ?? true) && device) {
        managers.expoManager.suppressDevMenuOnboarding();
      }
      if (device) {
        await managers.expoManager.waitForBundleComplete(6e4);
        const ready = await managers.maestroManager.verifyDeviceReady(device.device_id);
        if (!ready) {
          console.error("[expo-mcp] Warning: Device readiness probe failed");
        }
      }
      if (device && args2.auto_login?.flow_file) {
        try {
          await managers.maestroManager.callTool("run_flow_files", {
            device_id: device.device_id,
            flow_files: args2.auto_login.flow_file
          });
          console.error("[expo-mcp] Auto-login flow completed");
        } catch (e) {
          console.error(`[expo-mcp] Auto-login flow failed (non-fatal): ${e.message}`);
        }
      }
      let message;
      if (result.target) {
        const targetName = result.target === "ios-simulator" ? "iOS Simulator" : result.target === "android-emulator" ? "Android Emulator" : "Web Browser";
        if (device) {
          message = `Session started. ${targetName} connected (${device.device_name}).`;
        } else {
          message = `Server started on ${targetName} but device detection failed. Device tools may not work.`;
        }
      } else if (result.host === "tunnel") {
        message = "Server started with tunnel. Scan QR code in terminal or use exp_url in Expo Go.";
      } else if (result.host === "lan") {
        message = "Server started on LAN. Scan QR code in terminal or use exp_url in Expo Go.";
      } else {
        message = "Server started.";
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
    async stop_session() {
      if (managers.expoManager.getStatus() !== "running") {
        throw new Error("Session is not running. Nothing to stop.");
      }
      await managers.expoManager.stop();
      registry.update({
        status: "stopped",
        deviceId: null,
        deviceName: null,
        platform: null,
        port: null,
        target: null,
        host: "lan",
        // maestroPid intentionally kept — Maestro subprocess stays alive across sessions
        deviceLeasedAt: null,
        deviceLeaseExpiresAt: null,
        deviceLeaseTtlMs: null
      });
      return {
        content: [
          {
            type: "text",
            text: "Session stopped and device released."
          }
        ]
      };
    },
    async reload_app() {
      if (managers.expoManager.getStatus() !== "running") {
        throw new Error("Session is not running. Call start_session first.");
      }
      await managers.expoManager.reload();
      return {
        content: [
          {
            type: "text",
            text: "Reload command sent to connected device."
          }
        ]
      };
    },
    async get_logs(args2) {
      if (managers.expoManager.getStatus() !== "running") {
        throw new Error("Session is not running. Call start_session first.");
      }
      const logs = managers.expoManager.getLogs({
        limit: args2.limit,
        clear: args2.clear,
        level: args2.level,
        source: args2.source
      });
      if (logs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No logs available."
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
    },
    async press_key(args2) {
      const { deviceId: deviceId2 } = requireNativeDevice(registry, "press_key");
      const flowYaml = `- pressKey: ${args2.key}`;
      const result = await managers.maestroManager.callTool("run_flow", {
        flow_yaml: flowYaml,
        device_id: deviceId2
      });
      registry.touchLease();
      return result;
    },
    async scroll(args2) {
      const { deviceId: deviceId2 } = requireNativeDevice(registry, "scroll");
      const direction = args2.direction?.toUpperCase();
      const flowYaml = direction ? `- scroll:
    direction: ${direction}` : "- scroll";
      const result = await managers.maestroManager.callTool("run_flow", {
        flow_yaml: flowYaml,
        device_id: deviceId2
      });
      registry.touchLease();
      return result;
    },
    async swipe(args2) {
      const { deviceId: deviceId2 } = requireNativeDevice(registry, "swipe");
      let flowYaml;
      if (args2.start && args2.end) {
        let yaml = `- swipe:
    start: "${args2.start}"
    end: "${args2.end}"`;
        if (args2.duration) {
          yaml += `
    duration: ${args2.duration}`;
        }
        flowYaml = yaml;
      } else if (args2.direction) {
        let yaml = `- swipe:
    direction: ${args2.direction.toUpperCase()}`;
        if (args2.duration) {
          yaml += `
    duration: ${args2.duration}`;
        }
        flowYaml = yaml;
      } else {
        throw new Error('Either "direction" or both "start" and "end" must be provided.');
      }
      const result = await managers.maestroManager.callTool("run_flow", {
        flow_yaml: flowYaml,
        device_id: deviceId2
      });
      registry.touchLease();
      return result;
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
  "run_maestro_flow",
  "run_maestro_flow_files",
  "inspect_view_hierarchy"
];
var HIDDEN_TOOLS = ["launch_app", "stop_app", "start_device", "cheat_sheet", "query_docs"];
var REQUIRES_SESSION = "Requires: start_session must be called first.";
var TOOL_RENAME_MAP = {
  run_flow: "run_maestro_flow",
  run_flow_files: "run_maestro_flow_files",
  check_flow_syntax: "check_maestro_flow_syntax"
};
var REVERSE_RENAME_MAP = Object.fromEntries(
  Object.entries(TOOL_RENAME_MAP).map(([k, v]) => [v, k])
);
var TOOL_DESCRIPTION_ENHANCEMENTS = {
  take_screenshot: REQUIRES_SESSION,
  tap_on: REQUIRES_SESSION,
  input_text: REQUIRES_SESSION,
  back: REQUIRES_SESSION,
  run_maestro_flow: REQUIRES_SESSION,
  run_maestro_flow_files: REQUIRES_SESSION,
  inspect_view_hierarchy: REQUIRES_SESSION,
  list_devices: "Can be called without an active session.",
  check_maestro_flow_syntax: "Can be called without an active session."
};
var FALLBACK_MAESTRO_TOOLS = [
  { name: "take_screenshot", description: `Take a screenshot of the device screen. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: {} } },
  { name: "tap_on", description: `Tap on a UI element by text, id, or coordinates. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: { text: { type: "string", description: "Text of element to tap" }, id: { type: "string", description: "Accessibility ID of element to tap" }, point: { type: "string", description: 'Coordinates to tap (e.g. "50%,50%")' } } } },
  { name: "input_text", description: `Type text into the currently focused field. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to input" } }, required: ["text"] } },
  { name: "back", description: `Press the back button. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: {} } },
  { name: "run_maestro_flow", description: `Run a Maestro YAML flow. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: { flow_yaml: { type: "string", description: "YAML flow content" } }, required: ["flow_yaml"] } },
  { name: "run_maestro_flow_files", description: `Run Maestro flow files from the project directory. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Paths to Maestro flow files" } }, required: ["paths"] } },
  { name: "check_maestro_flow_syntax", description: `Validate Maestro YAML flow syntax without running it. Can be called without an active session.`, inputSchema: { type: "object", properties: { flow_yaml: { type: "string", description: "YAML flow content to validate" } }, required: ["flow_yaml"] } },
  { name: "inspect_view_hierarchy", description: `Get the UI element tree of the current screen. ${REQUIRES_SESSION}`, inputSchema: { type: "object", properties: {} } },
  { name: "list_devices", description: "List all available devices (simulators and emulators). Can be called without an active session.", inputSchema: { type: "object", properties: {} } }
];
function createMaestroToolsProxy(managers) {
  async function ensureInitialized() {
    if (managers.maestroManager.isReady()) return;
    await managers.maestroManager.initialize();
    const pid = managers.maestroManager.getPid();
    if (pid) {
      managers.registry.update({ maestroPid: pid });
    }
  }
  return {
    async getTools() {
      try {
        await ensureInitialized();
      } catch (error) {
        console.error("[expo-mcp] Failed to initialize Maestro for tools list:", error);
        return FALLBACK_MAESTRO_TOOLS;
      }
      const tools = managers.maestroManager.getTools();
      return tools.filter((tool) => !HIDDEN_TOOLS.includes(tool.name)).map((tool) => ({ ...tool, name: TOOL_RENAME_MAP[tool.name] ?? tool.name })).map((tool) => {
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
      }).map((tool) => {
        const enhancement = TOOL_DESCRIPTION_ENHANCEMENTS[tool.name];
        if (enhancement && !tool.description.includes(enhancement)) {
          return { ...tool, description: `${tool.description} ${enhancement}` };
        }
        return tool;
      });
    },
    async callTool(name, args2) {
      const maestroName = REVERSE_RENAME_MAP[name] ?? name;
      if (HIDDEN_TOOLS.includes(maestroName)) {
        throw new Error(`Unknown tool: ${name}`);
      }
      await ensureInitialized();
      let enhancedArgs = { ...args2 };
      if (DEVICE_REQUIRED_TOOLS.includes(name)) {
        const state = managers.registry.getSessionState();
        if (state.status !== "running") {
          throw new Error(
            "Session is not running. Call start_session first."
          );
        }
        if (state.target === "web-browser") {
          throw new Error(
            `"${name}" requires a native device. Not available for web-browser target.`
          );
        }
        if (!state.deviceId) {
          throw new Error(
            "Device lease expired. Call start_session to re-acquire the device."
          );
        }
        enhancedArgs = { ...args2, device_id: state.deviceId };
      }
      const result = await managers.maestroManager.callTool(maestroName, enhancedArgs);
      if (DEVICE_REQUIRED_TOOLS.includes(name)) {
        managers.registry.touchLease();
      }
      if (SCREENSHOT_TOOLS.includes(name)) {
        return await processScreenshotResponse(result);
      }
      return result;
    }
  };
}

// src/server.ts
function createToolFilter(config) {
  if (config?.essentialTools) {
    const set = new Set(config.essentialTools.split(",").map((t) => t.trim()).filter(Boolean));
    return (name) => set.has(name);
  }
  if (config?.excludeTools) {
    const set = new Set(config.excludeTools.split(",").map((t) => t.trim()).filter(Boolean));
    return (name) => !set.has(name);
  }
  return () => true;
}
var McpServer = class {
  server;
  expoManager;
  maestroManager;
  registry;
  lifecycleHandlers;
  maestroProxy;
  toolFilterConfig;
  constructor(appDir2, toolFilter, deviceId2) {
    this.toolFilterConfig = toolFilter;
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
    cleanupOrphanedMaestroProcesses();
    this.registry = new InstanceRegistry();
    this.registry.register(appDir2 ?? process.env.EXPO_APP_DIR ?? process.cwd());
    if (deviceId2) {
      this.registry.update({ deviceId: deviceId2 });
    }
    this.expoManager = new ExpoManager(this.registry, appDir2);
    this.maestroManager = new MaestroManager();
    this.lifecycleHandlers = createLifecycleHandlers({
      expoManager: this.expoManager,
      maestroManager: this.maestroManager,
      registry: this.registry
    });
    this.maestroProxy = createMaestroToolsProxy({
      maestroManager: this.maestroManager,
      registry: this.registry
    });
    this.setupHandlers();
  }
  setupHandlers() {
    const shouldInclude = createToolFilter(this.toolFilterConfig);
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
      const filteredTools = allTools.filter((tool) => shouldInclude(tool.name));
      return {
        tools: filteredTools
      };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args2 } = request.params;
      if (name in lifecycleToolSchemas) {
        const handler = this.lifecycleHandlers[name];
        if (!handler) {
          throw new Error(`Handler not implemented for tool: ${name}`);
        }
        try {
          const schema = lifecycleToolSchemas[name];
          const validatedArgs = schema.inputSchema.parse(args2 || {});
          return await handler(validatedArgs);
        } catch (error) {
          console.error(`[expo-mcp] Lifecycle tool error (${name}):`, error.message);
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
        return await this.maestroProxy.callTool(name, args2 || {});
      } catch (error) {
        if (error.message?.includes("Unknown tool")) {
          throw new Error(`Unknown tool: ${name}`);
        }
        console.error(`[expo-mcp] Maestro tool error (${name}):`, error.message);
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
    this.registry.deregister();
  }
};

// src/index.ts
function printUsage() {
  console.log(`Usage: expo-mcp [app-dir] [options]

MCP server for Expo/React Native app automation with Maestro integration.

Arguments:
  app-dir                      Path to Expo app directory (default: cwd)

Options:
  --exclude-tools=tool1,tool2  Exclude specific tools from the MCP server
  --tools=tool1,tool2          Only expose specific tools (mutually exclusive with --exclude-tools)
  --device-id=<id>             Specific device to use (iOS simulator UUID or Android serial)
  -h, --help                   Show this help message
  -v, --version                Show version number

Environment Variables:
  EXPO_APP_DIR                 Path to Expo app directory (CLI arg takes precedence)
  ESSENTIAL_TOOLS              Comma-separated list of tools to expose
  EXCLUDE_TOOLS                Comma-separated list of tools to exclude

Examples:
  expo-mcp                                        Use current directory
  expo-mcp apps/mobile                            Monorepo subdirectory
  expo-mcp --exclude-tools=list_devices            Exclude specific tools
  expo-mcp apps/mobile --exclude-tools=list_devices Combined usage
  expo-mcp apps/mobile --device-id=emulator-5554   Use specific Android emulator
  expo-mcp apps/mobile --device-id=6D192F60-...    Use specific iOS simulator`);
}
var args = process.argv.slice(2);
var appDir;
var essentialTools;
var excludeTools;
var deviceId;
for (const arg of args) {
  if (arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(0);
  } else if (arg === "--version" || arg === "-v") {
    console.log("expo-mcp 0.2.0");
    process.exit(0);
  } else if (arg.startsWith("--exclude-tools=")) {
    excludeTools = arg.slice("--exclude-tools=".length);
  } else if (arg.startsWith("--tools=")) {
    essentialTools = arg.slice("--tools=".length);
  } else if (arg.startsWith("--device-id=")) {
    deviceId = arg.slice("--device-id=".length);
  } else if (arg.startsWith("-")) {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  } else {
    appDir = arg;
  }
}
var resolvedAppDir = appDir || process.env.EXPO_APP_DIR || process.cwd();
var resolvedEssentialTools = essentialTools ?? process.env.ESSENTIAL_TOOLS;
var resolvedExcludeTools = excludeTools ?? process.env.EXCLUDE_TOOLS;
if (resolvedEssentialTools && resolvedExcludeTools) {
  console.error("Error: Cannot use both --tools and --exclude-tools simultaneously.");
  process.exit(1);
}
var server = new McpServer(resolvedAppDir, {
  essentialTools: resolvedEssentialTools,
  excludeTools: resolvedExcludeTools
}, deviceId);
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
