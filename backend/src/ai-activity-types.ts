export type AiRunState = 'running' | 'finished' | 'interrupted';

/** One observed lifecycle boundary or heartbeat, with a source-confirmed Unix millisecond timestamp. */
export interface AiRunObservation {
  runId: string;
  appName: string;
  title: string;
  at: number;
  state: AiRunState;
}

export interface AiActivitySource {
  /** Report newly observed boundaries and a heartbeat for every run still known to be active. */
  poll(signal: AbortSignal): Promise<AiRunObservation[]>;
  close?(): void | Promise<void>;
}
