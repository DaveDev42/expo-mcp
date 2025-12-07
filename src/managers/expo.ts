import { spawn, ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';

export interface ExpoLaunchOptions {
  port?: number;
  platform?: 'ios' | 'android';
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

  async launch(options: ExpoLaunchOptions = {}): Promise<{ url: string; port: number; platform: string | null }> {
    const port = options.port ?? 8081;
    const platform = options.platform ?? null;
    const waitForReady = options.wait_for_ready ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    if (this.process) {
      throw new Error('Expo server is already running. Stop it first.');
    }

    this.port = port;
    this.platform = platform;

    // Build command arguments
    // npx expo start --port <port> [--ios | --android]
    const args = ['expo', 'start', '--port', port.toString()];
    if (platform === 'ios') {
      args.push('--ios');
    } else if (platform === 'android') {
      args.push('--android');
    }

    // Launch Expo dev server
    this.process = spawn('npx', args, {
      cwd: this.appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
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
    return { url, port, platform };
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;

      proc.on('exit', () => {
        this.process = null;
        this.platform = null;
        resolve();
      });

      // Send SIGTERM
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(5000).then(() => {
        if (this.process === proc) {
          proc.kill('SIGKILL');
          this.process = null;
          this.platform = null;
          resolve();
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
