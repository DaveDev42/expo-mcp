import { spawn, ChildProcess, execSync } from 'child_process';
import { setTimeout } from 'timers/promises';
import { networkInterfaces } from 'os';
import { WebSocket } from 'ws';
import * as net from 'net';
import type { SessionStateProvider } from '../registry/session-state.js';

export type ExpoTarget = 'ios-simulator' | 'android-emulator' | 'web-browser';
export type ExpoHost = 'lan' | 'tunnel' | 'localhost';
export type LogLevel = 'log' | 'info' | 'warn' | 'error';
export type LogSource = 'stdout' | 'stderr';

export interface LogEntry {
  timestamp: number;
  source: LogSource;
  level: LogLevel;
  message: string;
}

export interface GetLogsOptions {
  limit?: number;
  clear?: boolean;
  level?: LogLevel;
  source?: LogSource;
}

export interface ExpoLaunchOptions {
  /** Target: auto-launch simulator/emulator */
  target?: ExpoTarget;

  /** Connection mode (for physical devices or override) */
  host?: ExpoHost;
  /** Offline mode - skip network requests */
  offline?: boolean;

  /** Server port (default: 8081) */
  port?: number;
  /** Clear bundler cache */
  clear?: boolean;

  /** Development mode (default: true), set false for --no-dev */
  dev?: boolean;
  /** Minify JavaScript bundle */
  minify?: boolean;
  /** Max Metro workers */
  max_workers?: number;

  /** Custom URI scheme */
  scheme?: string;

  /** iOS simulator name (e.g., "iPhone 16 Pro"). iOS only. */
  simulator_name?: string;

  /** Clean simulator state before launch (keychain reset, app data clear). Default: false */
  clean_state?: boolean;

  /** expo-mcp specific: wait for server ready */
  wait_for_ready?: boolean;
  /** expo-mcp specific: timeout in seconds */
  timeout_secs?: number;

  /** Registry port-claim check (injected by lifecycle handler) */
  isPortClaimed?: (port: number) => boolean;
}

export interface ExpoLaunchResult {
  url: string;
  exp_url: string;
  port: number;
  target: ExpoTarget | null;
  host: ExpoHost;
}

/**
 * Check if a port is available on localhost
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    // Listen on all interfaces to catch both IPv4 and IPv6 usage
    server.listen(port);
  });
}

/**
 * Find an available port starting from the given port
 * @param isPortClaimed Optional callback to check if a port is claimed by another instance
 */
async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 10,
  isPortClaimed?: (port: number) => boolean,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    // Check registry first (another expo-mcp instance may have claimed it)
    if (isPortClaimed && isPortClaimed(port)) {
      continue;
    }
    // Then check TCP availability (non-expo-mcp processes)
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`);
}

/**
 * Get the local network IP address for LAN connections
 */
function getLanIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      // Skip internal/loopback addresses
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

export class ExpoManager {
  private process: ChildProcess | null = null;
  private appDir: string;
  private logBuffer: LogEntry[] = [];
  private maxLogLines: number;
  private sessionState: SessionStateProvider;
  private static readonly EXPO_GO_MIN_STORAGE_MB = 300; // Expo Go APK is ~186MB, need extra for extraction
  private static readonly LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    log: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(sessionState: SessionStateProvider, appDir?: string) {
    this.sessionState = sessionState;
    this.appDir = appDir ?? process.env.EXPO_APP_DIR ?? process.cwd();
    this.maxLogLines = parseInt(process.env.LOG_BUFFER_SIZE || '400', 10);
  }

  /**
   * Get ADB path (tries common locations)
   */
  private getAdbPath(): string | null {
    const commonPaths = [
      process.env.ANDROID_HOME && `${process.env.ANDROID_HOME}/platform-tools/adb`,
      `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`,
      '/usr/local/bin/adb',
      'adb', // Fallback to PATH
    ].filter(Boolean) as string[];

    for (const adbPath of commonPaths) {
      try {
        execSync(`${adbPath} version`, { stdio: 'pipe' });
        return adbPath;
      } catch {
        // Try next path
      }
    }
    return null;
  }

  /**
   * Get connected Android device ID
   */
  private getConnectedAndroidDevice(adbPath: string): string | null {
    try {
      const output = execSync(`${adbPath} devices`, { encoding: 'utf8' });
      const lines = output.split('\n').slice(1); // Skip header
      for (const line of lines) {
        const [deviceId, status] = line.trim().split(/\s+/);
        if (deviceId && status === 'device') {
          return deviceId;
        }
      }
    } catch {
      // No device connected
    }
    return null;
  }

  /**
   * Check available storage on Android device (in MB)
   */
  private getAndroidAvailableStorage(adbPath: string, deviceId: string): number {
    try {
      const output = execSync(`${adbPath} -s ${deviceId} shell df /data`, { encoding: 'utf8' });
      // Parse df output - two possible formats:
      // 1. Human readable: "Filesystem Size Used Avail Use% Mounted on" with values like "542M"
      // 2. 1K-blocks: "Filesystem 1K-blocks Used Available Use% Mounted on" with numeric values
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const header = lines[0].toLowerCase();
        const parts = lines[1].split(/\s+/);
        // Avail/Available is typically the 4th column (index 3)
        const availStr = parts[3];
        if (availStr) {
          // Check if header indicates 1K-blocks format
          const is1KBlocks = header.includes('1k-block') || header.includes('1k block');

          // Try to parse - could be "542M", "1.2G", or plain number
          const match = availStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT])?/i);
          if (match) {
            let value = parseFloat(match[1]);
            const unit = (match[2] || '').toUpperCase();

            if (unit === 'K') {
              value /= 1024; // KB to MB
            } else if (unit === 'M') {
              // Already in MB
            } else if (unit === 'G') {
              value *= 1024; // GB to MB
            } else if (unit === 'T') {
              value *= 1024 * 1024; // TB to MB
            } else if (!unit) {
              // No unit - check if it's 1K-blocks format
              if (is1KBlocks) {
                value /= 1024; // 1K-blocks to MB
              } else {
                // Assume bytes
                value /= (1024 * 1024);
              }
            }
            return Math.floor(value);
          }
        }
      }
    } catch (error) {
      console.error('[Expo] Failed to check Android storage:', error);
    }
    return 0;
  }

  /**
   * Free up storage on Android device by clearing caches
   */
  private async freeAndroidStorage(adbPath: string, deviceId: string): Promise<void> {
    console.error('[Expo] Attempting to free Android storage...');

    const commands = [
      // Clear package manager caches
      'pm trim-caches 999999999999',
      // Clear Google Play Services cache (often large)
      'pm clear com.google.android.gms 2>/dev/null || true',
      // Clear Chrome cache if installed
      'pm clear com.android.chrome 2>/dev/null || true',
      // Remove large pre-installed apps (user 0 only, recoverable)
      'pm uninstall -k --user 0 com.google.android.youtube 2>/dev/null || true',
      'pm uninstall -k --user 0 com.google.android.apps.maps 2>/dev/null || true',
      'pm uninstall -k --user 0 com.google.android.videos 2>/dev/null || true',
    ];

    for (const cmd of commands) {
      try {
        execSync(`${adbPath} -s ${deviceId} shell ${cmd}`, { stdio: 'pipe' });
      } catch {
        // Continue even if some commands fail
      }
    }

    console.error('[Expo] Storage cleanup completed');
  }

  /**
   * Ensure Android device has enough storage for Expo Go
   */
  private async ensureAndroidStorage(adbPath: string, deviceId: string): Promise<void> {
    let availableMB = this.getAndroidAvailableStorage(adbPath, deviceId);
    console.error(`[Expo] Android available storage: ${availableMB}MB (need ${ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB)`);

    if (availableMB < ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
      console.error('[Expo] Insufficient storage, attempting cleanup...');
      await this.freeAndroidStorage(adbPath, deviceId);

      // Check again after cleanup
      availableMB = this.getAndroidAvailableStorage(adbPath, deviceId);
      console.error(`[Expo] Android available storage after cleanup: ${availableMB}MB`);

      if (availableMB < ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
        throw new Error(
          `Insufficient storage on Android device. Available: ${availableMB}MB, Required: ${ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB. ` +
            'Please free up space manually or use an emulator with more storage.'
        );
      }
    }
  }

  /** iOS 시뮬레이터에 Expo Go 설치 여부 확인 */
  private isExpoGoInstalledIOS(): boolean {
    const deviceId = this.sessionState.getSessionState().deviceId ?? 'booted';
    try {
      const output = execSync(`xcrun simctl listapps ${deviceId}`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      return output.includes('host.exp.Exponent');
    } catch { return false; }
  }

  /** Android 에뮬레이터에 Expo Go 설치 여부 확인 */
  private isExpoGoInstalledAndroid(adbPath: string): boolean {
    const deviceId = this.sessionState.getSessionState().deviceId;
    const deviceFlag = deviceId ? `-s ${deviceId} ` : '';
    try {
      const output = execSync(`${adbPath} ${deviceFlag}shell pm list packages host.exp.exponent`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      return output.includes('host.exp.exponent');
    } catch { return false; }
  }

  /** iOS 시뮬레이터 상태 정리 (키체인 리셋, Expo Go 종료) */
  private cleanIOSSimulatorState(): void {
    const deviceId = this.sessionState.getSessionState().deviceId ?? 'booted';
    console.error('[Expo] Cleaning iOS simulator state...');
    for (const cmd of [
      `xcrun simctl keychain ${deviceId} reset`,
      `xcrun simctl terminate ${deviceId} host.exp.Exponent`,
    ]) {
      try { execSync(cmd, { stdio: 'pipe', timeout: 10000 }); }
      catch { /* skip */ }
    }
  }

  /** Android 에뮬레이터 상태 정리 (Expo Go 앱 데이터 초기화) */
  private cleanAndroidEmulatorState(adbPath: string): void {
    const deviceId = this.sessionState.getSessionState().deviceId;
    const deviceFlag = deviceId ? `-s ${deviceId} ` : '';
    console.error('[Expo] Cleaning Android emulator state...');
    try { execSync(`${adbPath} ${deviceFlag}shell pm clear host.exp.exponent`, { stdio: 'pipe', timeout: 10000 }); }
    catch { /* skip */ }
  }

  /** iOS dev menu onboarding 억제 (UserDefaults 설정) */
  suppressDevMenuOnboardingIOS(): void {
    const deviceId = this.sessionState.getSessionState().deviceId ?? 'booted';
    try {
      execSync(
        `xcrun simctl spawn ${deviceId} defaults write host.exp.Exponent EXDevMenuIsOnboardingFinished -bool true`,
        { stdio: 'pipe', timeout: 10000 }
      );
      console.error('[Expo] iOS dev menu onboarding suppressed');
    } catch (e: any) {
      console.error(`[Expo] Failed to suppress iOS onboarding: ${e.message}`);
    }
  }

  /** Android dev menu onboarding 억제 (broadcast) */
  suppressDevMenuOnboardingAndroid(): void {
    const adbPath = this.getAdbPath();
    if (!adbPath) return;
    const deviceId = this.sessionState.getSessionState().deviceId;
    const deviceFlag = deviceId ? `-s ${deviceId} ` : '';
    try {
      execSync(`${adbPath} ${deviceFlag}shell am broadcast -a expo.modules.devmenu.DISABLE_ONBOARDING`,
        { stdio: 'pipe', timeout: 10000 });
      console.error('[Expo] Android dev menu onboarding suppressed');
    } catch (e: any) {
      console.error(`[Expo] Failed to suppress Android onboarding: ${e.message}`);
    }
  }

  /** 현재 타겟에 맞게 onboarding 억제 */
  suppressDevMenuOnboarding(): void {
    const target = this.sessionState.getSessionState().target;
    if (target === 'ios-simulator') this.suppressDevMenuOnboardingIOS();
    else if (target === 'android-emulator') this.suppressDevMenuOnboardingAndroid();
  }

  /** Metro 번들링 완료 대기 (로그 버퍼 감시) */
  async waitForBundleComplete(timeoutMs: number = 60000): Promise<boolean> {
    const startTime = Date.now();
    const patterns = [/Bundled \d+ms/i, /Bundle complete/i, /Log box/i];

    while (Date.now() - startTime < timeoutMs) {
      const recent = this.logBuffer.filter(l => l.timestamp > startTime);
      for (const log of recent) {
        if (patterns.some(p => p.test(log.message))) {
          console.error(`[Expo] Bundle ready: ${log.message.substring(0, 80)}`);
          return true;
        }
      }
      await setTimeout(1000);
    }
    console.error('[Expo] Bundle completion not detected within timeout');
    return false;
  }

  async launch(options: ExpoLaunchOptions = {}): Promise<ExpoLaunchResult> {
    const requestedPort = options.port ?? 8081;
    const target = options.target ?? null;
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    if (this.process) {
      throw new Error('Expo server is already running. Stop it first.');
    }

    // Find an available port (auto-increment if requested port is in use)
    const port = await findAvailablePort(requestedPort, 10, options.isPortClaimed);
    if (port !== requestedPort) {
      console.error(`[Expo] Port ${requestedPort} in use, using port ${port} instead`);
    }

    // Pre-flight check for Android storage
    if (target === 'android-emulator') {
      const adbPath = this.getAdbPath();
      if (adbPath) {
        const deviceId = this.getConnectedAndroidDevice(adbPath);
        if (deviceId) {
          await this.ensureAndroidStorage(adbPath, deviceId);
        }
      }
    }

    // Force hardware keyboard on iOS simulator to prevent software keyboard
    // from blocking UI elements during automated testing
    if (target === 'ios-simulator') {
      try {
        execSync('defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true', {
          stdio: 'pipe', timeout: 5000,
        });
        console.error('[Expo] iOS simulator hardware keyboard enabled');
      } catch { /* skip */ }
    }

    // Clean simulator/emulator state before launch
    if (options.clean_state) {
      if (target === 'ios-simulator') this.cleanIOSSimulatorState();
      else if (target === 'android-emulator') {
        const adbPath = this.getAdbPath();
        if (adbPath) this.cleanAndroidEmulatorState(adbPath);
      }
    }

    // port and target are written to registry by the lifecycle handler

    // Build command arguments: npx expo start [options]
    const args = ['expo', 'start', '--port', port.toString()];

    // Target → CLI flags
    if (target === 'ios-simulator') {
      args.push('--ios');
    } else if (target === 'android-emulator') {
      args.push('--android');
    } else if (target === 'web-browser') {
      args.push('--web');
    }

    // iOS simulator name selection
    if (target === 'ios-simulator' && options.simulator_name) {
      args.push('--device', options.simulator_name);
    }

    // Determine effective host mode
    let effectiveHost: ExpoHost;
    if (options.host) {
      // Explicit host specified
      effectiveHost = options.host;
    } else if (target === 'ios-simulator') {
      // iOS simulator defaults to localhost
      effectiveHost = 'localhost';
    } else {
      // Everything else defaults to lan
      effectiveHost = 'lan';
    }
    // effectiveHost is used in the return value below

    // Enable offline mode by default in MCP environment
    // This skips Expo server authentication (manifest signing) which requires EXPO_TOKEN
    // Users can override by explicitly setting offline: false
    // Note: Offline mode only affects Expo CLI communication, not app network features
    let shouldUseOffline = options.offline ?? true;

    // Auto-disable offline if Expo Go is not installed (needs network to download)
    if (shouldUseOffline && options.offline === undefined && target) {
      let installed = true;
      if (target === 'ios-simulator') {
        installed = this.isExpoGoInstalledIOS();
      } else if (target === 'android-emulator') {
        const adbPath = this.getAdbPath();
        installed = adbPath ? this.isExpoGoInstalledAndroid(adbPath) : true;
      }
      if (!installed) {
        console.error('[Expo] Expo Go not installed. Disabling offline mode for installation.');
        shouldUseOffline = false;
      }
    }

    // Host/offline flags are mutually exclusive in Expo CLI
    // --offline implies localhost behavior
    if (shouldUseOffline) {
      args.push('--offline');
    } else if (effectiveHost === 'tunnel') {
      args.push('--tunnel');
    } else if (effectiveHost === 'lan') {
      args.push('--lan');
    } else if (effectiveHost === 'localhost') {
      args.push('--localhost');
    }
    if (options.clear) {
      args.push('--clear');
    }
    if (options.dev === false) {
      args.push('--no-dev');
    }
    if (options.minify) {
      args.push('--minify');
    }
    if (options.max_workers !== undefined) {
      args.push('--max-workers', options.max_workers.toString());
    }
    if (options.scheme) {
      args.push('--scheme', options.scheme);
    }

    // Launch Expo dev server with detached process group for proper cleanup
    // Interactive prompts are already prevented because stdio is piped
    // (process.stdout.isTTY is false), making Expo CLI's isInteractive() return false.
    // We do NOT set CI=1 as it triggers full CI mode requiring EXPO_TOKEN.
    const env = { ...process.env };

    this.process = spawn('npx', args, {
      cwd: this.appDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      detached: true,
      shell: process.platform === 'win32', // Only use shell on Windows
    });

    // Capture output for debugging and log buffer
    this.process.stdout?.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        this.logBuffer.push({
          timestamp: Date.now(),
          source: 'stdout',
          level: this.parseLogLevel(line),
          message: line,
        });
        if (this.logBuffer.length > this.maxLogLines) {
          this.logBuffer.shift();
        }
      }
      console.error(`[Expo stdout] ${text}`);
    });

    this.process.stderr?.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        this.logBuffer.push({
          timestamp: Date.now(),
          source: 'stderr',
          level: this.parseLogLevel(line, 'error'),
          message: line,
        });
        if (this.logBuffer.length > this.maxLogLines) {
          this.logBuffer.shift();
        }
      }
      console.error(`[Expo stderr] ${text}`);
    });

    this.process.on('exit', (code) => {
      console.error(`[Expo] Process exited with code ${code}`);
      this.process = null;
    });

    if (waitForReady) {
      await this.waitForServer(port, timeoutSecs);
    }

    // Generate URLs based on host mode
    const hostname = effectiveHost === 'localhost' ? 'localhost' : getLanIP();
    const url = `http://${hostname}:${port}`;
    const exp_url = `exp://${hostname}:${port}`;

    return { url, exp_url, port, target, host: effectiveHost };
  }

  async stop(): Promise<void> {
    if (!this.process || !this.process.pid) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;
      const pid = proc.pid!;
      let forceKillTimeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
          forceKillTimeout = null;
        }
        this.process = null;
        resolve();
      };

      proc.on('exit', cleanup);

      // Kill process group on Unix, taskkill on Windows
      if (process.platform !== 'win32') {
        try {
          // Negative PID kills the entire process group
          process.kill(-pid, 'SIGTERM');
        } catch (e) {
          proc.kill('SIGTERM');
        }
      } else {
        spawn('taskkill', ['/PID', pid.toString(), '/T', '/F'], {
          stdio: 'ignore',
          shell: true,
        });
        proc.kill('SIGTERM');
      }

      // Force kill after 5 seconds if still running
      forceKillTimeout = global.setTimeout(() => {
        if (this.process === proc) {
          console.error('[Expo] Force killing process group');
          if (process.platform !== 'win32') {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch (e) {
              proc.kill('SIGKILL');
            }
          } else {
            proc.kill('SIGKILL');
          }
          cleanup();
        }
      }, 5000);
    });
  }

  getStatus(): 'running' | 'stopped' {
    return this.process ? 'running' : 'stopped';
  }

  getPort(): number | null {
    return this.sessionState.getSessionState().port;
  }

  getTarget(): ExpoTarget | null {
    return this.sessionState.getSessionState().target;
  }

  getHost(): ExpoHost {
    return this.sessionState.getSessionState().host;
  }

  getDeviceId(): string | null {
    return this.sessionState.getSessionState().deviceId;
  }

  hasActiveSession(): boolean {
    const s = this.sessionState.getSessionState();
    return s.status === 'running' && s.deviceId !== null;
  }

  /**
   * Reload the app on all connected devices via WebSocket message
   */
  async reload(): Promise<void> {
    if (!this.process) {
      throw new Error('Expo server is not running');
    }

    const port = this.sessionState.getSessionState().port;
    if (!port) {
      throw new Error('No port available for reload');
    }

    // Check for recent errors in log buffer that might indicate problems
    const recentErrors = this.logBuffer
      .filter((log) => log.level === 'error' && Date.now() - log.timestamp < 5000)
      .map((log) => log.message);

    if (recentErrors.some((msg) => /EADDRINUSE|port.*in use/i.test(msg))) {
      throw new Error('Port conflict detected. Stop other servers or use a different port.');
    }

    // Send reload via WebSocket /message endpoint
    const wsUrl = `ws://localhost:${port}/message`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeoutId = global.setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.on('open', () => {
        // Send reload message in the format expected by Metro/Expo
        // Protocol version 2 is required
        const message = JSON.stringify({ version: 2, method: 'reload' });
        ws.send(message);

        // Give it a moment to broadcast, then close
        global.setTimeout(() => {
          clearTimeout(timeoutId);
          ws.close();
          resolve();
        }, 100);
      });

      ws.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`WebSocket error: ${error.message}`));
      });
    });
  }

  /**
   * Parse log level from message content
   */
  private parseLogLevel(line: string, defaultLevel: LogLevel = 'log'): LogLevel {
    if (/\b(error|ERR!|ERROR)\b/i.test(line)) return 'error';
    if (/\b(warn|warning|WARN)\b/i.test(line)) return 'warn';
    if (/\b(info|INFO)\b/i.test(line)) return 'info';
    return defaultLevel;
  }

  /**
   * Get captured logs with optional filtering
   */
  getLogs(options: GetLogsOptions = {}): LogEntry[] {
    const { limit, clear = false, level, source } = options;

    let logs = [...this.logBuffer];

    // Filter by minimum log level
    if (level) {
      const minPriority = ExpoManager.LOG_LEVEL_PRIORITY[level];
      logs = logs.filter((l) => ExpoManager.LOG_LEVEL_PRIORITY[l.level] >= minPriority);
    }

    // Filter by source
    if (source) {
      logs = logs.filter((l) => l.source === source);
    }

    // Apply limit (get last N entries)
    if (limit) {
      logs = logs.slice(-limit);
    }

    // Clear buffer if requested
    if (clear) {
      this.logBuffer = [];
    }

    return logs;
  }

  private async waitForServer(port: number, timeoutSecs: number): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`http://localhost:${port}/status`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }

      await setTimeout(1000);
    }

    throw new Error(`Expo server did not become ready within ${timeoutSecs} seconds`);
  }
}
