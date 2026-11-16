export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error' | 'unavailable';

export interface RecorderStatus {
  mode?: 'screen' | 'ai';
  state: RecorderState;
  supported: boolean;
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  message: string;
  savedCount: number;
  lastSavedAt: string | null;
  sessionStartedAt: string | null;
  targetTaskId?: string | null;
  observedTaskId?: string | null;
  observedAt?: string | null;
}
