import { spawn, ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';
import { networkInterfaces } from 'os';

export type ExpoTarget = 'ios-simulator' | 'android-emulator' | 'web-browser';
export type ExpoHost = 'lan' | 'tunnel' | 'localhost';

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

  /** expo-mcp specific: wait for server ready */
  wait_for_ready?: boolean;
  /** expo-mcp specific: timeout in seconds */
  timeout_secs?: number;
}

export interface ExpoLaunchResult {
  url: string;
  exp_url: string;
  port: number;
  target: ExpoTarget | null;
  host: ExpoHost;
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
  private port: number = 8081;
  private target: ExpoTarget | null = null;
  private host: ExpoHost = 'lan';
  private appDir: string;

  constructor(appDir?: string) {
    this.appDir = appDir ?? process.env.EXPO_APP_DIR ?? process.cwd();
  }

  async launch(options: ExpoLaunchOptions = {}): Promise<ExpoLaunchResult> {
    const port = options.port ?? 8081;
    const target = options.target ?? null;
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    if (this.process) {
      throw new Error('Expo server is already running. Stop it first.');
    }

    this.port = port;
    this.target = target;

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
    this.host = effectiveHost;

    // Host → CLI flags
    if (effectiveHost === 'tunnel') {
      args.push('--tunnel');
    } else if (effectiveHost === 'lan') {
      args.push('--lan');
    } else if (effectiveHost === 'localhost') {
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
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: true,
      shell: process.platform === 'win32', // Only use shell on Windows
    });

    // Capture output for debugging
    this.process.stdout?.on('data', (data) => {
      console.error(`[Expo stdout] ${data.toString()}`);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[Expo stderr] ${data.toString()}`);
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
      setTimeout(5000).then(() => {
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
      });
    });
  }

  getStatus(): 'running' | 'stopped' {
    return this.process ? 'running' : 'stopped';
  }

  getPort(): number {
    return this.port;
  }

  getTarget(): ExpoTarget | null {
    return this.target;
  }

  getHost(): ExpoHost {
    return this.host;
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
