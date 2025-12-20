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
export class MaestroManagerPool {
    managers = new Map();
    defaultDeviceId = null;
    /**
     * Maximum number of concurrent managers (to prevent resource exhaustion)
     */
    static MAX_POOL_SIZE = 5;
    /**
     * Get or create a MaestroManager for the specified device
     */
    async getManager(deviceId) {
        if (this.managers.has(deviceId)) {
            return this.managers.get(deviceId);
        }
        if (this.managers.size >= MaestroManagerPool.MAX_POOL_SIZE) {
            throw new Error(`Maximum pool size (${MaestroManagerPool.MAX_POOL_SIZE}) reached. ` +
                `Shutdown unused managers before adding new ones.`);
        }
        console.error(`[MaestroPool] Creating new manager for device: ${deviceId}`);
        const manager = new MaestroManager();
        await manager.initialize();
        manager.setTargetDeviceId(deviceId);
        this.managers.set(deviceId, manager);
        // Set as default if first manager
        if (!this.defaultDeviceId) {
            this.defaultDeviceId = deviceId;
        }
        return manager;
    }
    /**
     * Get the default MaestroManager (first added or explicitly set)
     */
    getDefaultManager() {
        if (!this.defaultDeviceId) {
            return null;
        }
        return this.managers.get(this.defaultDeviceId) ?? null;
    }
    /**
     * Set the default device ID
     */
    setDefaultDeviceId(deviceId) {
        if (!this.managers.has(deviceId)) {
            throw new Error(`Device ${deviceId} not in pool. Call getManager first.`);
        }
        this.defaultDeviceId = deviceId;
    }
    /**
     * Get default device ID
     */
    getDefaultDeviceId() {
        return this.defaultDeviceId;
    }
    /**
     * List all managed device IDs
     */
    listManagedDevices() {
        return Array.from(this.managers.keys());
    }
    /**
     * Check if a device is in the pool
     */
    hasDevice(deviceId) {
        return this.managers.has(deviceId);
    }
    /**
     * Get pool size
     */
    size() {
        return this.managers.size;
    }
    /**
     * Remove a device from the pool and shutdown its manager
     */
    async removeDevice(deviceId) {
        const manager = this.managers.get(deviceId);
        if (manager) {
            console.error(`[MaestroPool] Removing device: ${deviceId}`);
            await manager.shutdown();
            this.managers.delete(deviceId);
            // Update default if we removed the default device
            if (this.defaultDeviceId === deviceId) {
                const remaining = Array.from(this.managers.keys());
                this.defaultDeviceId = remaining.length > 0 ? remaining[0] : null;
            }
        }
    }
    /**
     * Shutdown all managers in the pool
     */
    async shutdown() {
        console.error(`[MaestroPool] Shutting down ${this.managers.size} managers`);
        const shutdownPromises = Array.from(this.managers.values()).map((manager) => manager.shutdown().catch((err) => console.error('[MaestroPool] Shutdown error:', err)));
        await Promise.all(shutdownPromises);
        this.managers.clear();
        this.defaultDeviceId = null;
    }
    /**
     * Execute a callback on all managers in parallel
     */
    async executeOnAll(callback) {
        const results = new Map();
        const promises = Array.from(this.managers.entries()).map(async ([deviceId, manager]) => {
            try {
                const result = await callback(manager, deviceId);
                results.set(deviceId, result);
            }
            catch (error) {
                console.error(`[MaestroPool] Error on device ${deviceId}:`, error);
                throw error;
            }
        });
        await Promise.all(promises);
        return results;
    }
}
//# sourceMappingURL=maestro-pool.js.map