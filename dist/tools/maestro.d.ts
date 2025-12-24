import { MaestroManager } from '../managers/maestro.js';
import { ExpoManager } from '../managers/expo.js';
export interface MaestroToolsProxy {
    maestroManager: MaestroManager;
    expoManager: ExpoManager;
}
export declare function createMaestroToolsProxy(managers: MaestroToolsProxy): {
    getTools(): Promise<import("../managers/maestro.js").MaestroTool[]>;
    callTool(name: string, args: any): Promise<any>;
};
//# sourceMappingURL=maestro.d.ts.map