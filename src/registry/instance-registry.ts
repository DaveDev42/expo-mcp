import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ExpoTarget, ExpoHost } from '../managers/expo.js';
import type { SessionState, SessionStateProvider } from './session-state.js';

export interface InstanceRecord {
  instanceId: string;
  pid: number;
  appDir: string;
  port: number | null;
  target: ExpoTarget | null;
  host: ExpoHost;
  deviceId: string | null;
  deviceName: string | null;
  platform: string | null;
  /** PID of the Maestro MCP subprocess, if running */
  maestroPid: number | null;
  status: 'starting' | 'running' | 'stopped';
  startedAt: number;
  updatedAt: number;
  // Device lease fields
  deviceLeasedAt: number | null;
  deviceLeaseExpiresAt: number | null;
  deviceLeaseTtlMs: number | null;
}

type UpdatableFields = Partial<Omit<InstanceRecord, 'instanceId' | 'pid' | 'appDir' | 'startedAt' | 'updatedAt'>>;

/**
 * Validate device ID format to prevent command injection.
 * Accepts iOS simulator UUIDs and Android emulator serials.
 */
function isValidDeviceId(id: string): boolean {
  // iOS simulator UUID: 8-4-4-4-12 hex
  // Android emulator serial: emulator-NNNN
  // Also allow plain alphanumeric/dash/underscore/dot (e.g. device names from adb)
  return /^[a-zA-Z0-9._:-]+$/.test(id);
}

export class InstanceRegistry implements SessionStateProvider {
  private readonly instanceId: string;
  private readonly dir: string;
  private readonly filePath: string;

  constructor() {
    this.instanceId = randomUUID();
    this.dir = join(tmpdir(), 'expo-mcp', 'instances');
    this.filePath = join(this.dir, `${this.instanceId}.json`);
  }

  register(appDir: string): void {
    mkdirSync(this.dir, { recursive: true });

    const record: InstanceRecord = {
      instanceId: this.instanceId,
      pid: process.pid,
      appDir,
      port: null,
      target: null,
      host: 'lan',
      deviceId: null,
      deviceName: null,
      platform: null,
      maestroPid: null,
      status: 'stopped',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      deviceLeasedAt: null,
      deviceLeaseExpiresAt: null,
      deviceLeaseTtlMs: null,
    };

    writeFileSync(this.filePath, JSON.stringify(record), 'utf8');
  }

  update(fields: UpdatableFields): void {
    // Validate deviceId at the write boundary to prevent command injection
    if (fields.deviceId != null && !isValidDeviceId(fields.deviceId)) {
      throw new Error(`Invalid device ID format: ${fields.deviceId}`);
    }

    const record = this.get();
    if (!record) return;

    const updated = { ...record, ...fields, updatedAt: Date.now() };
    writeFileSync(this.filePath, JSON.stringify(updated), 'utf8');
  }

  get(): InstanceRecord | null {
    try {
      const data = readFileSync(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  deregister(): void {
    try {
      unlinkSync(this.filePath);
    } catch {
      // File may already be gone
    }
  }

  getSessionState(): SessionState {
    const record = this.get();
    if (!record) {
      return { port: null, target: null, host: 'lan', deviceId: null, status: 'stopped' };
    }

    // Self-evict expired lease
    if (record.deviceId && record.deviceLeaseExpiresAt && Date.now() > record.deviceLeaseExpiresAt) {
      this.update({
        deviceId: null, deviceName: null, platform: null,
        deviceLeasedAt: null, deviceLeaseExpiresAt: null, deviceLeaseTtlMs: null,
      });
      return {
        port: record.port,
        target: record.target,
        host: record.host,
        deviceId: null,
        status: record.status,
      };
    }

    return {
      port: record.port,
      target: record.target,
      host: record.host,
      deviceId: record.deviceId,
      status: record.status,
    };
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  // --- Cross-instance queries ---

  listAll(): InstanceRecord[] {
    if (!existsSync(this.dir)) return [];

    const records: InstanceRecord[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = readFileSync(join(this.dir, file), 'utf8');
        const record: InstanceRecord = JSON.parse(data);

        // Verify PID is still alive; clean up stale entries
        if (!this.isProcessAlive(record.pid)) {
          try { unlinkSync(join(this.dir, file)); } catch { /* ignore */ }
          continue;
        }

        records.push(record);
      } catch {
        // Corrupted file, skip
      }
    }
    return records;
  }

  isPortClaimed(port: number): boolean {
    return this.listAll().some(
      (r) => r.instanceId !== this.instanceId && r.port === port && r.status !== 'stopped'
    );
  }

  isDeviceClaimed(deviceId: string): InstanceRecord | null {
    const match = this.listAll().find(
      (r) => r.instanceId !== this.instanceId && r.deviceId === deviceId && r.status !== 'stopped'
    );
    if (!match) return null;

    // Lazy eviction: if lease has expired, clear device and skip
    if (match.deviceLeaseExpiresAt && Date.now() > match.deviceLeaseExpiresAt) {
      this.evictExpiredLease(match);
      return null;
    }

    return match;
  }

  getClaimedDeviceIds(): string[] {
    return this.listAll()
      .filter((r) => {
        if (r.instanceId === this.instanceId || !r.deviceId || r.status === 'stopped') return false;
        // Lazy eviction: skip expired leases
        if (r.deviceLeaseExpiresAt && Date.now() > r.deviceLeaseExpiresAt) {
          this.evictExpiredLease(r);
          return false;
        }
        return true;
      })
      .map((r) => r.deviceId!);
  }

  touchLease(): void {
    const record = this.get();
    if (!record?.deviceId || !record.deviceLeaseTtlMs) return;
    this.update({
      deviceLeaseExpiresAt: Date.now() + record.deviceLeaseTtlMs,
    });
  }

  private evictExpiredLease(record: InstanceRecord): void {
    try {
      const filePath = join(this.dir, `${record.instanceId}.json`);
      const data = readFileSync(filePath, 'utf8');
      const current: InstanceRecord = JSON.parse(data);
      const updated = {
        ...current,
        deviceId: null,
        deviceName: null,
        platform: null,
        deviceLeasedAt: null,
        deviceLeaseExpiresAt: null,
        deviceLeaseTtlMs: null,
        updatedAt: Date.now(),
      };
      writeFileSync(filePath, JSON.stringify(updated), 'utf8');
    } catch {
      // File may be gone or corrupted; ignore
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
