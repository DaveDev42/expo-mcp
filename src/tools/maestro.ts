import { MaestroManager } from '../managers/maestro.js';

export interface MaestroToolsProxy {
  maestroManager: MaestroManager;
}

export function createMaestroToolsProxy(managers: MaestroToolsProxy) {
  return {
    getTools() {
      return managers.maestroManager.getTools();
    },

    async callTool(name: string, args: any) {
      return await managers.maestroManager.callTool(name, args);
    },
  };
}
