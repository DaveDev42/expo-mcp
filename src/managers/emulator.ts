import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { setTimeout } from 'timers/promises';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

const execAsync = promisify(exec);

export interface ExpoGoInfo {
  installed: boolean;
  version?: string;
  packageName: string;
}

// Expo Go package name and download URLs
const EXPO_GO_PACKAGE_NAME = 'host.exp.exponent';
const EXPO_GO_APK_URL = 'https://d1ahtucjixef4r.cloudfront.net/Exponent-2.32.13.apk';

export class EmulatorManager {
  private process: ChildProcess | null = null;
  private currentDevice: string | null = null;
  private downloadDir: string;

  constructor() {
    this.downloadDir = path.join(os.tmpdir(), 'expo-mcp-downloads');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  async listDevices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('emulator -list-avds');
      return stdout
        .trim()
        .split('\n')
        .filter((name) => name.length > 0);
    } catch (error: any) {
      if (error.message.includes('command not found')) {
        throw new Error(
          'Android emulator not found. Make sure ANDROID_HOME is set and emulator is in PATH.'
        );
      }
      throw error;
    }
  }

  async start(
    deviceName?: string,
    options: { wait_for_boot?: boolean; timeout_secs?: number } = {}
  ): Promise<string> {
    const waitForBoot = options.wait_for_boot ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    if (this.process) {
      if (deviceName && this.currentDevice !== deviceName) {
        throw new Error(
          `A different emulator is already running: ${this.currentDevice}. Stop it first.`
        );
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

  async getRunningEmulator(): Promise<string | null> {
    try {
      const { stdout } = await execAsync('adb devices');
      const lines = stdout.trim().split('\n').slice(1); // Skip header

      for (const line of lines) {
        if (line.includes('emulator') && line.includes('device')) {
          // Found running emulator
          // Try to get AVD name
          const deviceId = line.split('\t')[0];
          try {
            const { stdout: avdName } = await execAsync(
              `adb -s ${deviceId} emu avd name 2>/dev/null || echo "unknown"`
            );
            const name = avdName.trim().split('\n')[0];
            return name !== 'unknown' ? name : 'running';
          } catch {
            return 'running';
          }
        }
      }
    } catch {
      // adb not available or no devices
    }

    return null;
  }

  /**
   * Get the device ID of the running emulator
   */
  async getEmulatorDeviceId(): Promise<string | null> {
    try {
      const { stdout } = await execAsync('adb devices');
      const lines = stdout.trim().split('\n').slice(1);

      for (const line of lines) {
        if (line.includes('emulator') && line.includes('device')) {
          return line.split('\t')[0];
        }
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * Check if Expo Go is installed on the emulator
   */
  async isExpoGoInstalled(): Promise<ExpoGoInfo> {
    const deviceId = await this.getEmulatorDeviceId();
    if (!deviceId) {
      return { installed: false, packageName: EXPO_GO_PACKAGE_NAME };
    }

    try {
      const { stdout } = await execAsync(
        `adb -s ${deviceId} shell pm list packages | grep ${EXPO_GO_PACKAGE_NAME}`
      );
      if (stdout.includes(EXPO_GO_PACKAGE_NAME)) {
        // Try to get version
        try {
          const { stdout: versionOutput } = await execAsync(
            `adb -s ${deviceId} shell dumpsys package ${EXPO_GO_PACKAGE_NAME} | grep versionName`
          );
          const versionMatch = versionOutput.match(/versionName=([^\s]+)/);
          return {
            installed: true,
            version: versionMatch?.[1],
            packageName: EXPO_GO_PACKAGE_NAME,
          };
        } catch {
          return { installed: true, packageName: EXPO_GO_PACKAGE_NAME };
        }
      }
    } catch {
      // Package not found
    }

    return { installed: false, packageName: EXPO_GO_PACKAGE_NAME };
  }

  /**
   * Download Expo Go APK for Android
   */
  async downloadExpoGo(): Promise<string> {
    const expoVersion = '2.32.13';
    const targetPath = path.join(this.downloadDir, `ExpoGo-${expoVersion}.apk`);

    // Check if already downloaded
    if (fs.existsSync(targetPath)) {
      console.error(`[EmulatorManager] Using cached Expo Go at ${targetPath}`);
      return targetPath;
    }

    console.error(`[EmulatorManager] Downloading Expo Go from ${EXPO_GO_APK_URL}`);

    await this.downloadFile(EXPO_GO_APK_URL, targetPath);

    if (!fs.existsSync(targetPath)) {
      throw new Error('Failed to download Expo Go APK');
    }

    return targetPath;
  }

  /**
   * Install Expo Go on the emulator
   */
  async installExpoGo(): Promise<{ installed: boolean; message: string }> {
    const deviceId = await this.getEmulatorDeviceId();
    if (!deviceId) {
      throw new Error('No running emulator found. Start an emulator first.');
    }

    // Check if already installed
    const expoGoInfo = await this.isExpoGoInstalled();
    if (expoGoInfo.installed) {
      return { installed: true, message: 'Expo Go is already installed' };
    }

    // Download Expo Go APK
    const apkPath = await this.downloadExpoGo();

    // Install the APK
    console.error(`[EmulatorManager] Installing Expo Go on emulator ${deviceId}...`);
    await execAsync(`adb -s ${deviceId} install -r "${apkPath}"`);

    // Verify installation
    const verifyInfo = await this.isExpoGoInstalled();
    if (!verifyInfo.installed) {
      throw new Error('Failed to install Expo Go');
    }

    return { installed: true, message: 'Expo Go installed successfully' };
  }

  /**
   * Open a URL in Expo Go on the emulator
   */
  async openInExpoGo(expoUrl: string): Promise<{ success: boolean; message: string }> {
    const deviceId = await this.getEmulatorDeviceId();
    if (!deviceId) {
      throw new Error('No running emulator found. Start an emulator first.');
    }

    // Ensure Expo Go is installed
    const expoGoInfo = await this.isExpoGoInstalled();
    if (!expoGoInfo.installed) {
      throw new Error('Expo Go is not installed. Install it first using install_expo_go.');
    }

    // Convert http URL to exp:// scheme
    let expUrl = expoUrl;
    if (expoUrl.startsWith('http://')) {
      expUrl = expoUrl.replace('http://', 'exp://');
    } else if (expoUrl.startsWith('https://')) {
      expUrl = expoUrl.replace('https://', 'exp://');
    } else if (!expoUrl.startsWith('exp://')) {
      expUrl = `exp://${expoUrl}`;
    }

    console.error(`[EmulatorManager] Opening ${expUrl} in Expo Go...`);

    // Open the URL using adb
    await execAsync(
      `adb -s ${deviceId} shell am start -a android.intent.action.VIEW -d "${expUrl}" ${EXPO_GO_PACKAGE_NAME}`
    );

    return { success: true, message: `Opened ${expUrl} in Expo Go` };
  }

  /**
   * Launch Expo Go app on the emulator
   */
  async launchExpoGo(): Promise<{ success: boolean; message: string }> {
    const deviceId = await this.getEmulatorDeviceId();
    if (!deviceId) {
      throw new Error('No running emulator found. Start an emulator first.');
    }

    // Ensure Expo Go is installed
    const expoGoInfo = await this.isExpoGoInstalled();
    if (!expoGoInfo.installed) {
      throw new Error('Expo Go is not installed. Install it first using install_expo_go.');
    }

    // Launch the app
    await execAsync(
      `adb -s ${deviceId} shell monkey -p ${EXPO_GO_PACKAGE_NAME} -c android.intent.category.LAUNCHER 1`
    );

    return { success: true, message: 'Expo Go launched' };
  }

  /**
   * Force stop Expo Go app on the emulator
   */
  async stopExpoGo(): Promise<void> {
    const deviceId = await this.getEmulatorDeviceId();
    if (!deviceId) {
      return;
    }

    try {
      await execAsync(`adb -s ${deviceId} shell am force-stop ${EXPO_GO_PACKAGE_NAME}`);
    } catch {
      // App might not be running
    }
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
          const { stdout: bootOutput } = await execAsync(
            'adb shell getprop sys.boot_completed'
          );
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

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);

      const request = https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      });

      request.on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {}); // Delete partial file
        reject(err);
      });

      file.on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {}); // Delete partial file
        reject(err);
      });
    });
  }
}
