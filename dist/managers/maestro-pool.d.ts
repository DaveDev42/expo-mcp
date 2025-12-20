import { MaestroManager } from './maestro.js';
/**
 * Pool of MaestroManager instances for concurrent multi-device testing.
 *
 * Each device gets its own MaestroManager instance, allowing parallel
 * test execution across multiple iOS Simulators or Android Emulators.
 *
 * Usage:
 * - For single device testing, use MaestroManager directly
 * - For multi-device parallel testing, use MaestroManagerPool
 */
export declare class MaestroManagerPool {
    private managers;
    private defaultDeviceId;
    /**
     * Maximum number of concurrent managers (to prevent resource exhaustion)
     */
    private static readonly MAX_POOL_SIZE;
    /**
     * Get or create a MaestroManager for the specified device
     */
    getManager(deviceId: string): Promise<MaestroManager>;
    /**
     * Get the default MaestroManager (first added or explicitly set)
     */
    getDefaultManager(): MaestroManager | null;
    /**
     * Set the default device ID
     */
    setDefaultDeviceId(deviceId: string): void;
    /**
     * Get default device ID
     */
    getDefaultDeviceId(): string | null;
    /**
     * List all managed device IDs
     */
    listManagedDevices(): string[];
    /**
     * Check if a device is in the pool
     */
    hasDevice(deviceId: string): boolean;
    /**
     * Get pool size
     */
    size(): number;
    /**
     * Remove a device from the pool and shutdown its manager
     */
    removeDevice(deviceId: string): Promise<void>;
    /**
     * Shutdown all managers in the pool
     */
    shutdown(): Promise<void>;
    /**
     * Execute a callback on all managers in parallel
     */
    executeOnAll<T>(callback: (manager: MaestroManager, deviceId: string) => Promise<T>): Promise<Map<string, T>>;
}
//# sourceMappingURL=maestro-pool.d.ts.map