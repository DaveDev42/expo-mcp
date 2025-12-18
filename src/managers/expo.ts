import { spawn, ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';

export interface ExpoLaunchOptions {
  port?: number;
  platform?: 'ios' | 'android';
  /** Connection mode: 'lan' for LAN IP, 'tunnel' for ngrok tunnel, 'localhost' for local */
  connection?: 'lan' | 'tunnel' | 'localhost';
  /** Custom hostname override (takes precedence over connection mode) */
  hostname?: string;
  wait_for_ready?: boolean;
  timeout_secs?: number;
}

export class ExpoManager {
  private process: ChildProcess | null = null;
  private port: number = 8081;
  private platform: 'ios' | 'android' | null = null;
  private appDir: string;

  constructor(appDir?: string) {
    this.appDir = appDir ?? process.env.EXPO_APP_DIR ?? process.cwd();
  }

  async launch(options: ExpoLaunchOptions = {}): Promise<{ url: string; port: number; platform: string | null; connection: string }> {
    const port = options.port ?? 8081;
    const platform = options.platform ?? null;
    const connection = options.connection ?? null;
    const hostname = options.hostname ?? null;
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    if (this.process) {
      throw new Error('Expo server is already running. Stop it first.');
    }

    this.port = port;
    this.platform = platform;

    // Build command arguments
    // npx expo start --port <port> [--ios | --android] [--tunnel | --lan | --localhost]
    const args = ['expo', 'start', '--port', port.toString()];
    if (platform === 'ios') {
      args.push('--ios');
    } else if (platform === 'android') {
      args.push('--android');
    }

    // Connection mode flag for Expo CLI
    let effectiveConnection: string | null = connection;
    if (connection === 'tunnel') {
      args.push('--tunnel');
    } else if (connection === 'lan') {
      args.push('--lan');
    } else if (connection === 'localhost') {
      args.push('--localhost');
    }

    // Launch Expo dev server with detached process group for proper cleanup
    const env = { ...process.env };

    // Custom hostname takes precedence
    if (hostname) {
      env.REACT_NATIVE_PACKAGER_HOSTNAME = hostname;
      effectiveConnection = `custom:${hostname}`;
    } else if (!connection) {
      // Default behavior based on platform when no explicit connection mode
      // iOS simulator: use localhost (same machine)
      // Android: use default (auto-detect LAN IP for emulator)
      if (platform === 'ios') {
        env.REACT_NATIVE_PACKAGER_HOSTNAME = 'localhost';
        effectiveConnection = 'localhost';
      } else {
        effectiveConnection = 'lan';
      }
    }

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

    const url = `http://localhost:${port}`;
    return { url, port, platform, connection: effectiveConnection ?? 'lan' };
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
        this.platform = null;
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

  getPlatform(): 'ios' | 'android' | null {
    return this.platform;
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
