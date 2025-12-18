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
export declare class ExpoManager {
    private process;
    private port;
    private target;
    private host;
    private appDir;
    private static readonly EXPO_GO_MIN_STORAGE_MB;
    constructor(appDir?: string);
    /**
     * Get ADB path (tries common locations)
     */
    private getAdbPath;
    /**
     * Get connected Android device ID
     */
    private getConnectedAndroidDevice;
    /**
     * Check available storage on Android device (in MB)
     */
    private getAndroidAvailableStorage;
    /**
     * Free up storage on Android device by clearing caches
     */
    private freeAndroidStorage;
    /**
     * Ensure Android device has enough storage for Expo Go
     */
    private ensureAndroidStorage;
    launch(options?: ExpoLaunchOptions): Promise<ExpoLaunchResult>;
    stop(): Promise<void>;
    getStatus(): 'running' | 'stopped';
    getPort(): number;
    getTarget(): ExpoTarget | null;
    getHost(): ExpoHost;
    private waitForServer;
}
//# sourceMappingURL=expo.d.ts.map