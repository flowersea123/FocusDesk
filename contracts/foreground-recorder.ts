export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error' | 'unavailable';

export interface RecorderStatus {
  state: RecorderState;
  supported: boolean;
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  message: string;
  savedCount: number;
  lastSavedAt: string | null;
  sessionStartedAt: string | null;
}
