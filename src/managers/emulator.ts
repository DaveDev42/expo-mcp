import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { setTimeout } from 'timers/promises';

const execAsync = promisify(exec);

export class EmulatorManager {
  private process: ChildProcess | null = null;
  private currentDevice: string | null = null;

  async listDevices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('emulator -list-avds');
      return stdout
        .trim()
        .split('\n')
        .filter(name => name.length > 0);
    } catch (error: any) {
      if (error.message.includes('command not found')) {
        throw new Error('Android emulator not found. Make sure ANDROID_HOME is set and emulator is in PATH.');
      }
      throw error;
    }
  }

  async start(deviceName?: string, options: { wait_for_boot?: boolean; timeout_secs?: number } = {}): Promise<string> {
    const waitForBoot = options.wait_for_boot ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    if (this.process) {
      if (deviceName && this.currentDevice !== deviceName) {
        throw new Error(`A different emulator is already running: ${this.currentDevice}. Stop it first.`);
      }
      return this.currentDevice!;
    }

    // Check if an emulator is already running
    const runningEmulator = await this.getRunningEmulator();
    if (runningEmulator) {
      if (deviceName && runningEmulator !== deviceName) {
        throw new Error(`A different emulator is already running. Stop it first.`);
      }
      this.currentDevice = runningEmulator;
      return runningEmulator;
    }

    const devices = await this.listDevices();
    let targetDevice: string;

    if (deviceName) {
      if (!devices.includes(deviceName)) {
        throw new Error(`Emulator "${deviceName}" not found. Available: ${devices.join(', ')}`);
      }
      targetDevice = deviceName;
    } else {
      if (devices.length === 0) {
        throw new Error('No Android emulators found. Create one using Android Studio.');
      }
      targetDevice = devices[0];
    }

    // Start emulator in background
    this.process = spawn('emulator', ['-avd', targetDevice, '-no-snapshot-save'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    this.currentDevice = targetDevice;

    // Capture output for debugging
    this.process.stdout?.on('data', (data) => {
      console.error(`[Emulator stdout] ${data.toString()}`);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[Emulator stderr] ${data.toString()}`);
    });

    this.process.on('exit', (code) => {
      console.error(`[Emulator] Process exited with code ${code}`);
      this.process = null;
      this.currentDevice = null;
    });

    if (waitForBoot) {
      await this.waitForBoot(timeoutSecs);
    }

    return targetDevice;
  }

  async stop(): Promise<void> {
    try {
      // Try to kill via adb
      await execAsync('adb emu kill');
      await setTimeout(2000);
    } catch {
      // Ignore errors
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      await setTimeout(2000);

      if (this.process) {
        this.process.kill('SIGKILL');
      }
    }

    this.process = null;
    this.currentDevice = null;
  }

  private async getRunningEmulator(): Promise<string | null> {
    try {
      const { stdout } = await execAsync('adb devices');
      const lines = stdout.trim().split('\n').slice(1); // Skip header

      for (const line of lines) {
        if (line.includes('emulator') && line.includes('device')) {
          // Found running emulator
          // We don't have a reliable way to get the AVD name from adb,
          // so we just return a generic indicator
          return 'running';
        }
      }
    } catch {
      // adb not available or no devices
    }

    return null;
  }

  private async waitForBoot(timeoutSecs: number): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check if device is online and boot completed
        const { stdout: devicesOutput } = await execAsync('adb devices');
        if (devicesOutput.includes('device') && !devicesOutput.includes('offline')) {
          // Check boot completion
          const { stdout: bootOutput } = await execAsync('adb shell getprop sys.boot_completed');
          if (bootOutput.trim() === '1') {
            // Wait a bit more for the system to be fully ready
            await setTimeout(3000);
            return;
          }
        }
      } catch {
        // Continue waiting
      }

      await setTimeout(2000);
    }

    throw new Error(`Emulator did not boot within ${timeoutSecs} seconds`);
  }
}
