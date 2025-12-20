import { z } from 'zod';
import { ExpoManager } from '../managers/expo.js';
import { MaestroManager } from '../managers/maestro.js';
export interface LifecycleTools {
    expoManager: ExpoManager;
    maestroManager: MaestroManager;
}
export declare const lifecycleToolSchemas: {
    app_status: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    list_devices: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    switch_device: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            device_id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            device_id: string;
        }, {
            device_id: string;
        }>;
    };
    launch_expo: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            target: z.ZodOptional<z.ZodEnum<["ios-simulator", "android-emulator", "web-browser"]>>;
            host: z.ZodOptional<z.ZodEnum<["lan", "tunnel", "localhost"]>>;
            offline: z.ZodOptional<z.ZodBoolean>;
            port: z.ZodOptional<z.ZodNumber>;
            clear: z.ZodOptional<z.ZodBoolean>;
            dev: z.ZodOptional<z.ZodBoolean>;
            minify: z.ZodOptional<z.ZodBoolean>;
            max_workers: z.ZodOptional<z.ZodNumber>;
            scheme: z.ZodOptional<z.ZodString>;
            wait_for_ready: z.ZodOptional<z.ZodBoolean>;
            timeout_secs: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            port?: number | undefined;
            target?: "ios-simulator" | "android-emulator" | "web-browser" | undefined;
            host?: "lan" | "tunnel" | "localhost" | undefined;
            clear?: boolean | undefined;
            offline?: boolean | undefined;
            dev?: boolean | undefined;
            minify?: boolean | undefined;
            max_workers?: number | undefined;
            scheme?: string | undefined;
            wait_for_ready?: boolean | undefined;
            timeout_secs?: number | undefined;
        }, {
            port?: number | undefined;
            target?: "ios-simulator" | "android-emulator" | "web-browser" | undefined;
            host?: "lan" | "tunnel" | "localhost" | undefined;
            clear?: boolean | undefined;
            offline?: boolean | undefined;
            dev?: boolean | undefined;
            minify?: boolean | undefined;
            max_workers?: number | undefined;
            scheme?: string | undefined;
            wait_for_ready?: boolean | undefined;
            timeout_secs?: number | undefined;
        }>;
    };
    stop_expo: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    };
    get_logs: {
        name: string;
        description: string;
        inputSchema: z.ZodObject<{
            limit: z.ZodOptional<z.ZodNumber>;
            clear: z.ZodOptional<z.ZodBoolean>;
            level: z.ZodOptional<z.ZodEnum<["log", "info", "warn", "error"]>>;
            source: z.ZodOptional<z.ZodEnum<["stdout", "stderr"]>>;
        }, "strip", z.ZodTypeAny, {
            limit?: number | undefined;
            clear?: boolean | undefined;
            level?: "log" | "info" | "warn" | "error" | undefined;
            source?: "stdout" | "stderr" | undefined;
        }, {
            limit?: number | undefined;
            clear?: boolean | undefined;
            level?: "log" | "info" | "warn" | "error" | undefined;
            source?: "stdout" | "stderr" | undefined;
        }>;
    };
};
export declare function createLifecycleHandlers(managers: LifecycleTools): {
    app_status(): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    list_devices(): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    switch_device(args: z.infer<typeof lifecycleToolSchemas.switch_device.inputSchema>): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        isError: boolean;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        isError?: undefined;
    }>;
    launch_expo(args: z.infer<typeof lifecycleToolSchemas.launch_expo.inputSchema>): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    stop_expo(): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
    get_logs(args: z.infer<typeof lifecycleToolSchemas.get_logs.inputSchema>): Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
//# sourceMappingURL=lifecycle.d.ts.map