import { MaestroManager } from '../managers/maestro.js';

export interface MaestroToolsProxy {
  maestroManager: MaestroManager;
}

export function createMaestroToolsProxy(managers: MaestroToolsProxy) {
  return {
    async getTools() {
      if (!managers.maestroManager.isReady()) {
        try {
          await managers.maestroManager.initialize();
        } catch (error) {
          console.error('[expo-mcp] Failed to initialize Maestro for tools list:', error);
          return [];
        }
      }
      return managers.maestroManager.getTools();
    },

    async callTool(name: string, args: any) {
      return await managers.maestroManager.callTool(name, args);
    },
  };
}
