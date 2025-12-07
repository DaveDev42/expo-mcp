import { exec } from 'child_process';
import { promisify } from 'util';
import { setTimeout } from 'timers/promises';

const execAsync = promisify(exec);

export interface Device {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

export class SimulatorManager {
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
        });
      }
    }

    return devices;
  }

  async boot(deviceName?: string, options: { wait_for_boot?: boolean; timeout_secs?: number } = {}): Promise<{ udid: string; name: string }> {
    const waitForBoot = options.wait_for_boot ?? true;
    const timeoutSecs = options.timeout_secs ?? 120;

    // Check if there's already a booted device
    const bootedDevice = await this.getBootedDevice();
    if (bootedDevice) {
      if (deviceName && bootedDevice.name !== deviceName) {
        throw new Error(`A different simulator is already booted: ${bootedDevice.name}. Shut it down first.`);
      }
      return { udid: bootedDevice.udid, name: bootedDevice.name };
    }

    // Find device to boot
    const devices = await this.listDevices();
    let targetDevice: Device | undefined;

    if (deviceName) {
      targetDevice = devices.find(d => d.name === deviceName && d.isAvailable);
      if (!targetDevice) {
        throw new Error(`Simulator "${deviceName}" not found or not available`);
      }
    } else {
      // Find first available iOS device (prefer iPhone)
      targetDevice = devices.find(d =>
        d.isAvailable &&
        d.state === 'Shutdown' &&
        d.name.includes('iPhone')
      ) || devices.find(d => d.isAvailable && d.state === 'Shutdown');

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
    return devices.find(d => d.state === 'Booted') || null;
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
}
