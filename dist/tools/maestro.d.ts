import { MaestroManager } from '../managers/maestro.js';
export interface MaestroToolsProxy {
    maestroManager: MaestroManager;
}
export declare function createMaestroToolsProxy(managers: MaestroToolsProxy): {
    getTools(): Promise<import("../managers/maestro.js").MaestroTool[]>;
    callTool(name: string, args: any): Promise<any>;
};
//# sourceMappingURL=maestro.d.ts.map