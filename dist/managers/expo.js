import { spawn, execSync } from 'child_process';
import { setTimeout } from 'timers/promises';
import { networkInterfaces } from 'os';
import { WebSocket } from 'ws';
/**
 * Get the local network IP address for LAN connections
 */
function getLanIP() {
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
    process = null;
    port = 8081;
    target = null;
    host = 'lan';
    appDir;
    logBuffer = [];
    maxLogLines;
    static EXPO_GO_MIN_STORAGE_MB = 300; // Expo Go APK is ~186MB, need extra for extraction
    static LOG_LEVEL_PRIORITY = {
        log: 0,
        info: 1,
        warn: 2,
        error: 3,
    };
    constructor(appDir) {
        this.appDir = appDir ?? process.env.EXPO_APP_DIR ?? process.cwd();
        this.maxLogLines = parseInt(process.env.LOG_BUFFER_SIZE || '400', 10);
    }
    /**
     * Get ADB path (tries common locations)
     */
    getAdbPath() {
        const commonPaths = [
            process.env.ANDROID_HOME && `${process.env.ANDROID_HOME}/platform-tools/adb`,
            `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`,
            '/usr/local/bin/adb',
            'adb', // Fallback to PATH
        ].filter(Boolean);
        for (const adbPath of commonPaths) {
            try {
                execSync(`${adbPath} version`, { stdio: 'pipe' });
                return adbPath;
            }
            catch {
                // Try next path
            }
        }
        return null;
    }
    /**
     * Get connected Android device ID
     */
    getConnectedAndroidDevice(adbPath) {
        try {
            const output = execSync(`${adbPath} devices`, { encoding: 'utf8' });
            const lines = output.split('\n').slice(1); // Skip header
            for (const line of lines) {
                const [deviceId, status] = line.trim().split(/\s+/);
                if (deviceId && status === 'device') {
                    return deviceId;
                }
            }
        }
        catch {
            // No device connected
        }
        return null;
    }
    /**
     * Check available storage on Android device (in MB)
     */
    getAndroidAvailableStorage(adbPath, deviceId) {
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
                        }
                        else if (unit === 'M') {
                            // Already in MB
                        }
                        else if (unit === 'G') {
                            value *= 1024; // GB to MB
                        }
                        else if (unit === 'T') {
                            value *= 1024 * 1024; // TB to MB
                        }
                        else if (!unit) {
                            // No unit - check if it's 1K-blocks format
                            if (is1KBlocks) {
                                value /= 1024; // 1K-blocks to MB
                            }
                            else {
                                // Assume bytes
                                value /= (1024 * 1024);
                            }
                        }
                        return Math.floor(value);
                    }
                }
            }
        }
        catch (error) {
            console.error('[Expo] Failed to check Android storage:', error);
        }
        return 0;
    }
    /**
     * Free up storage on Android device by clearing caches
     */
    async freeAndroidStorage(adbPath, deviceId) {
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
            }
            catch {
                // Continue even if some commands fail
            }
        }
        console.error('[Expo] Storage cleanup completed');
    }
    /**
     * Ensure Android device has enough storage for Expo Go
     */
    async ensureAndroidStorage(adbPath, deviceId) {
        let availableMB = this.getAndroidAvailableStorage(adbPath, deviceId);
        console.error(`[Expo] Android available storage: ${availableMB}MB (need ${ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB)`);
        if (availableMB < ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
            console.error('[Expo] Insufficient storage, attempting cleanup...');
            await this.freeAndroidStorage(adbPath, deviceId);
            // Check again after cleanup
            availableMB = this.getAndroidAvailableStorage(adbPath, deviceId);
            console.error(`[Expo] Android available storage after cleanup: ${availableMB}MB`);
            if (availableMB < ExpoManager.EXPO_GO_MIN_STORAGE_MB) {
                throw new Error(`Insufficient storage on Android device. Available: ${availableMB}MB, Required: ${ExpoManager.EXPO_GO_MIN_STORAGE_MB}MB. ` +
                    'Please free up space manually or use an emulator with more storage.');
            }
        }
    }
    async launch(options = {}) {
        const port = options.port ?? 8081;
        const target = options.target ?? null;
        const waitForReady = options.wait_for_ready ?? true;
        const timeoutSecs = options.timeout_secs ?? 120;
        if (this.process) {
            throw new Error('Expo server is already running. Stop it first.');
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
        this.port = port;
        this.target = target;
        // Build command arguments: npx expo start [options]
        const args = ['expo', 'start', '--port', port.toString()];
        // Target → CLI flags
        if (target === 'ios-simulator') {
            args.push('--ios');
        }
        else if (target === 'android-emulator') {
            args.push('--android');
        }
        else if (target === 'web-browser') {
            args.push('--web');
        }
        // Determine effective host mode
        let effectiveHost;
        if (options.host) {
            // Explicit host specified
            effectiveHost = options.host;
        }
        else if (target === 'ios-simulator') {
            // iOS simulator defaults to localhost
            effectiveHost = 'localhost';
        }
        else {
            // Everything else defaults to lan
            effectiveHost = 'lan';
        }
        this.host = effectiveHost;
        // Host → CLI flags
        if (effectiveHost === 'tunnel') {
            args.push('--tunnel');
        }
        else if (effectiveHost === 'lan') {
            args.push('--lan');
        }
        else if (effectiveHost === 'localhost') {
            args.push('--localhost');
        }
        // Other options
        if (options.offline) {
            args.push('--offline');
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
                this.host = 'lan';
                resolve();
            };
            proc.on('exit', cleanup);
            // Kill process group on Unix, taskkill on Windows
            if (process.platform !== 'win32') {
                try {
                    // Negative PID kills the entire process group
                    process.kill(-pid, 'SIGTERM');
                }
                catch (e) {
                    proc.kill('SIGTERM');
                }
            }
            else {
                spawn('taskkill', ['/PID', pid.toString(), '/T', '/F'], {
                    stdio: 'ignore',
                    shell: true,
                });
                proc.kill('SIGTERM');
            }
            // Force kill after 5 seconds if still running
            setTimeout(5000).then(() => {
                if (this.process === proc) {
                    console.error('[Expo] Force killing process group');
                    if (process.platform !== 'win32') {
                        try {
                            process.kill(-pid, 'SIGKILL');
                        }
                        catch (e) {
                            proc.kill('SIGKILL');
                        }
                    }
                    else {
                        proc.kill('SIGKILL');
                    }
                    cleanup();
                }
            });
        });
    }
    getStatus() {
        return this.process ? 'running' : 'stopped';
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
    /**
     * Reload the app on all connected devices via WebSocket message
     */
    async reload() {
        if (!this.process) {
            throw new Error('Expo server is not running');
        }
        // Check for recent errors in log buffer that might indicate problems
        const recentErrors = this.logBuffer
            .filter((log) => log.level === 'error' && Date.now() - log.timestamp < 5000)
            .map((log) => log.message);
        if (recentErrors.some((msg) => /EADDRINUSE|port.*in use/i.test(msg))) {
            throw new Error('Port conflict detected. Stop other servers or use a different port.');
        }
        // Send reload via WebSocket /message endpoint
        const wsUrl = `ws://localhost:${this.port}/message`;
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
    parseLogLevel(line, defaultLevel = 'log') {
        if (/\b(error|ERR!|ERROR)\b/i.test(line))
            return 'error';
        if (/\b(warn|warning|WARN)\b/i.test(line))
            return 'warn';
        if (/\b(info|INFO)\b/i.test(line))
            return 'info';
        return defaultLevel;
    }
    /**
     * Get captured logs with optional filtering
     */
    getLogs(options = {}) {
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
    async waitForServer(port, timeoutSecs) {
        const startTime = Date.now();
        const timeoutMs = timeoutSecs * 1000;
        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await fetch(`http://localhost:${port}/status`);
                if (response.ok) {
                    return;
                }
            }
            catch {
                // Server not ready yet
            }
            await setTimeout(1000);
        }
        throw new Error(`Expo server did not become ready within ${timeoutSecs} seconds`);
    }
}
//# sourceMappingURL=expo.js.map