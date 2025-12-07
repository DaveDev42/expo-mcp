import { exec } from 'child_process';
import { promisify } from 'util';
import { setTimeout } from 'timers/promises';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

const execAsync = promisify(exec);

export interface Device {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  runtime?: string;
}

export interface ExpoGoInfo {
  installed: boolean;
  version?: string;
  bundleId: string;
}

// Expo Go bundle ID and download URLs
const EXPO_GO_BUNDLE_ID = 'host.exp.Exponent';
const EXPO_GO_DOWNLOAD_BASE = 'https://dpq5q02fu5f55.cloudfront.net/Exponent';

export class SimulatorManager {
  private downloadDir: string;

  constructor() {
    this.downloadDir = path.join(os.tmpdir(), 'expo-mcp-downloads');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  async listDevices(): Promise<Device[]> {
    const { stdout } = await execAsync('xcrun simctl list devices --json');
    const data = JSON.parse(stdout);

    const devices: Device[] = [];
    for (const runtime in data.devices) {
      const runtimeDevices = data.devices[runtime];
      for (const device of runtimeDevices) {
        devices.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          isAvailable: device.isAvailable ?? true,
          runtime,
        });
      }
    }

    return devices;
  }

  async boot(
    deviceName?: string,
    options: { wait_for_boot?: boolean; timeout_secs?: number } = {}
  ): Promise<{ udid: string; name: string }> {
    const waitForBoot = options.wait_for_boot ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    // Check if there's already a booted device
    const bootedDevice = await this.getBootedDevice();
    if (bootedDevice) {
      if (deviceName && bootedDevice.name !== deviceName) {
        throw new Error(
          `A different simulator is already booted: ${bootedDevice.name}. Shut it down first.`
        );
      }
      // Open Simulator.app to show the device
      await execAsync('open -a Simulator');
      return { udid: bootedDevice.udid, name: bootedDevice.name };
    }

    // Find device to boot
    const devices = await this.listDevices();
    let targetDevice: Device | undefined;

    if (deviceName) {
      targetDevice = devices.find((d) => d.name === deviceName && d.isAvailable);
      if (!targetDevice) {
        throw new Error(`Simulator "${deviceName}" not found or not available`);
      }
    } else {
      // Find first available iOS device (prefer iPhone with latest iOS)
      const availableDevices = devices
        .filter((d) => d.isAvailable && d.state === 'Shutdown' && d.name.includes('iPhone'))
        .sort((a, b) => {
          // Sort by runtime version (descending)
          const versionA = a.runtime?.match(/iOS-(\d+)-(\d+)/);
          const versionB = b.runtime?.match(/iOS-(\d+)-(\d+)/);
          if (versionA && versionB) {
            const majorA = parseInt(versionA[1]);
            const majorB = parseInt(versionB[1]);
            if (majorA !== majorB) return majorB - majorA;
            return parseInt(versionB[2]) - parseInt(versionA[2]);
          }
          return 0;
        });

      targetDevice =
        availableDevices[0] || devices.find((d) => d.isAvailable && d.state === 'Shutdown');

      if (!targetDevice) {
        throw new Error('No available simulators found');
      }
    }

    // Boot the device
    try {
      await execAsync(`xcrun simctl boot ${targetDevice.udid}`);
    } catch (error: any) {
      // Ignore "Unable to boot device in current state: Booted" error
      if (!error.message.includes('current state: Booted')) {
        throw error;
      }
    }

    // Open Simulator.app to show the device
    await execAsync('open -a Simulator');

    if (waitForBoot) {
      await this.waitForBoot(targetDevice.udid, timeoutSecs);
    }

    return { udid: targetDevice.udid, name: targetDevice.name };
  }

  async shutdown(udid?: string): Promise<void> {
    if (udid) {
      await execAsync(`xcrun simctl shutdown ${udid}`);
    } else {
      // Shutdown all booted devices
      const bootedDevice = await this.getBootedDevice();
      if (bootedDevice) {
        await execAsync(`xcrun simctl shutdown ${bootedDevice.udid}`);
      }
    }
  }

  async getBootedDevice(): Promise<Device | null> {
    const devices = await this.listDevices();
    return devices.find((d) => d.state === 'Booted') || null;
  }

  /**
   * Check if Expo Go is installed on the simulator
   */
  async isExpoGoInstalled(udid?: string): Promise<ExpoGoInfo> {
    const targetUdid = udid || (await this.getBootedDevice())?.udid;
    if (!targetUdid) {
      return { installed: false, bundleId: EXPO_GO_BUNDLE_ID };
    }

    try {
      // Check if the app is installed by trying to get its container
      const { stdout } = await execAsync(
        `xcrun simctl get_app_container ${targetUdid} ${EXPO_GO_BUNDLE_ID}`
      );
      if (stdout.trim()) {
        return { installed: true, bundleId: EXPO_GO_BUNDLE_ID };
      }
    } catch {
      // App not installed
    }

    return { installed: false, bundleId: EXPO_GO_BUNDLE_ID };
  }

  /**
   * Get the iOS version of a simulator
   */
  async getSimulatorIOSVersion(udid: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync('xcrun simctl list devices --json');
      const data = JSON.parse(stdout);

      for (const runtime in data.devices) {
        const device = data.devices[runtime].find((d: any) => d.udid === udid);
        if (device) {
          // Extract version from runtime string like "com.apple.CoreSimulator.SimRuntime.iOS-17-0"
          const match = runtime.match(/iOS-(\d+)-(\d+)/);
          if (match) {
            return `${match[1]}.${match[2]}`;
          }
        }
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Download Expo Go app for iOS Simulator
   */
  async downloadExpoGo(iosVersion?: string): Promise<string> {
    // Get the latest Expo Go version info
    const expoVersion = await this.getLatestExpoGoVersion();
    const targetPath = path.join(this.downloadDir, `ExpoGo-${expoVersion}.app`);

    // Check if already downloaded
    if (fs.existsSync(targetPath)) {
      console.error(`[SimulatorManager] Using cached Expo Go at ${targetPath}`);
      return targetPath;
    }

    // Download URL format: https://dpq5q02fu5f55.cloudfront.net/Exponent-{version}.tar.gz
    const downloadUrl = `${EXPO_GO_DOWNLOAD_BASE}-${expoVersion}.tar.gz`;
    const tarPath = path.join(this.downloadDir, `ExpoGo-${expoVersion}.tar.gz`);

    console.error(`[SimulatorManager] Downloading Expo Go from ${downloadUrl}`);

    await this.downloadFile(downloadUrl, tarPath);

    // Extract the tar.gz
    console.error(`[SimulatorManager] Extracting Expo Go...`);
    await execAsync(`tar -xzf "${tarPath}" -C "${this.downloadDir}"`);

    // The extracted app should be named "Exponent.app"
    const extractedPath = path.join(this.downloadDir, 'Exponent.app');
    if (fs.existsSync(extractedPath)) {
      fs.renameSync(extractedPath, targetPath);
    }

    // Clean up tar file
    fs.unlinkSync(tarPath);

    if (!fs.existsSync(targetPath)) {
      throw new Error('Failed to extract Expo Go app');
    }

    return targetPath;
  }

  /**
   * Install Expo Go on the simulator
   */
  async installExpoGo(udid?: string): Promise<{ installed: boolean; message: string }> {
    const targetUdid = udid || (await this.getBootedDevice())?.udid;
    if (!targetUdid) {
      throw new Error('No booted simulator found. Boot a simulator first.');
    }

    // Check if already installed
    const expoGoInfo = await this.isExpoGoInstalled(targetUdid);
    if (expoGoInfo.installed) {
      return { installed: true, message: 'Expo Go is already installed' };
    }

    // Get iOS version for the simulator
    const iosVersion = await this.getSimulatorIOSVersion(targetUdid);
    console.error(`[SimulatorManager] Simulator iOS version: ${iosVersion}`);

    // Download Expo Go
    const appPath = await this.downloadExpoGo(iosVersion || undefined);

    // Install the app
    console.error(`[SimulatorManager] Installing Expo Go on simulator ${targetUdid}...`);
    await execAsync(`xcrun simctl install ${targetUdid} "${appPath}"`);

    // Verify installation
    const verifyInfo = await this.isExpoGoInstalled(targetUdid);
    if (!verifyInfo.installed) {
      throw new Error('Failed to install Expo Go');
    }

    return { installed: true, message: 'Expo Go installed successfully' };
  }

  /**
   * Open a URL in Expo Go on the simulator
   */
  async openInExpoGo(
    expoUrl: string,
    udid?: string
  ): Promise<{ success: boolean; message: string }> {
    const targetUdid = udid || (await this.getBootedDevice())?.udid;
    if (!targetUdid) {
      throw new Error('No booted simulator found. Boot a simulator first.');
    }

    // Ensure Expo Go is installed
    const expoGoInfo = await this.isExpoGoInstalled(targetUdid);
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

    console.error(`[SimulatorManager] Opening ${expUrl} in Expo Go...`);

    // Open the URL using simctl
    await execAsync(`xcrun simctl openurl ${targetUdid} "${expUrl}"`);

    return { success: true, message: `Opened ${expUrl} in Expo Go` };
  }

  /**
   * Launch Expo Go app on the simulator
   */
  async launchExpoGo(udid?: string): Promise<{ success: boolean; message: string }> {
    const targetUdid = udid || (await this.getBootedDevice())?.udid;
    if (!targetUdid) {
      throw new Error('No booted simulator found. Boot a simulator first.');
    }

    // Ensure Expo Go is installed
    const expoGoInfo = await this.isExpoGoInstalled(targetUdid);
    if (!expoGoInfo.installed) {
      throw new Error('Expo Go is not installed. Install it first using install_expo_go.');
    }

    // Launch the app
    await execAsync(`xcrun simctl launch ${targetUdid} ${EXPO_GO_BUNDLE_ID}`);

    return { success: true, message: 'Expo Go launched' };
  }

  /**
   * Terminate Expo Go app on the simulator
   */
  async terminateExpoGo(udid?: string): Promise<void> {
    const targetUdid = udid || (await this.getBootedDevice())?.udid;
    if (!targetUdid) {
      return;
    }

    try {
      await execAsync(`xcrun simctl terminate ${targetUdid} ${EXPO_GO_BUNDLE_ID}`);
    } catch {
      // App might not be running
    }
  }

  private async waitForBoot(udid: string, timeoutSecs: number): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const { stdout } = await execAsync(`xcrun simctl list devices --json`);
        const data = JSON.parse(stdout);

        // Find the device and check if it's booted
        for (const runtime in data.devices) {
          const device = data.devices[runtime].find((d: any) => d.udid === udid);
          if (device && device.state === 'Booted') {
            // Wait a bit more for the device to be fully ready
            await setTimeout(2000);
            return;
          }
        }
      } catch {
        // Continue waiting
      }

      await setTimeout(1000);
    }

    throw new Error(`Simulator did not boot within ${timeoutSecs} seconds`);
  }

  private async getLatestExpoGoVersion(): Promise<string> {
    // For now, use a known working version
    // In production, this could fetch from Expo's API
    return '2.32.13';
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
