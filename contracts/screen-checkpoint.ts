export type CheckpointSource = 'manual' | 'automatic';

export function checkpointSourceLabel(source?: CheckpointSource): string {
  return source === 'automatic' ? '自动记录' : '手动确认';
}

/** Earlier records were all reviewed manually and omit source. Only text is stored. */
export interface ScreenCheckpoint {
  id: string;
  source?: CheckpointSource;
  capturedAt: string;
  taskId: string | null;
  summary: string;
  nextStep: string;
  completedParts?: string[];
  progress: { percent: number; evidence: string } | null;
}

export interface CheckpointHistory {
  records: ScreenCheckpoint[];
}
