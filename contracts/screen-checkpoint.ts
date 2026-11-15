/** Only user-confirmed text is stored. Captured pixels are never part of this record. */
export interface ScreenCheckpoint {
  id: string;
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
