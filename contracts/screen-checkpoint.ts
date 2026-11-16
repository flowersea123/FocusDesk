export type CheckpointSource = 'manual' | 'automatic';

export function checkpointSourceLabel(source?: CheckpointSource): string {
  return source === 'automatic' ? '自动记录' : '手动确认';
}

/** Earlier records were all reviewed manually and omit source. Only text is stored. */
export interface ScreenCheckpoint {
  id: string;
  source?: CheckpointSource;
  /** Display name of the frontmost application for a desktop recording. */
  appName?: string;
  /** Page title reported by the foreground application at capture time. */
  pageTitle?: string;
  /** The system supplied the page title while local image analysis was unavailable. */
  detailSource?: 'window-title';
  capturedAt: string;
  taskId: string | null;
  summary: string;
  nextStep: string;
  completedParts?: string[];
  /** Visible document section. Only a separate, explicit reader confirmation completes it. */
  readingSection?: string;
  readingDocument?: string;
  readingConfirmed?: true;
  progress: { percent: number; evidence: string } | null;
}

export function validReadingSection(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 64 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export function validReadingDocument(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 180 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export interface CheckpointHistory {
  records: ScreenCheckpoint[];
  hasMore?: true;
}
