import type { ExpoTarget, ExpoHost } from '../managers/expo.js';

export interface SessionState {
  port: number | null;
  target: ExpoTarget | null;
  host: ExpoHost;
  deviceId: string | null;
  status: 'starting' | 'running' | 'stopped';
}

export interface SessionStateProvider {
  getSessionState(): SessionState;
}
