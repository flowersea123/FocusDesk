export type CheckpointSource = 'manual' | 'automatic';

/** Visible activity on a working document or reading material, independent of task ownership. */
export interface ActivityEvidence {
  kind: 'work' | 'reading';
  title: string;
  subject?: string;
  section?: string;
  /** Named questions with a visible personal answer; submission is tracked separately. */
  answeredItems?: string[];
  completedItems?: string[];
}
export interface ReadingPosition { page: number; total: number }
/** Only document identity and viewer location are retained from a paper frame. */
export interface ArxivPaper {
  id: string;
  view: 'abstract' | 'pdf';
  title?: string;
  position?: ReadingPosition;
}
export function validArxivId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]{1,30}\/\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v[1-9]\d{0,3})?$/iu.test(value);
}
export function validArxivPaper(value: unknown): value is ArxivPaper {
  if (!value || typeof value !== 'object') return false;
  const paper = value as ArxivPaper;
  return validArxivId(paper.id) && (paper.view === 'abstract' || paper.view === 'pdf') &&
    (paper.title === undefined || (typeof paper.title === 'string' && !!paper.title.trim() &&
      [...paper.title].length <= 400 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(paper.title))) &&
    (paper.position === undefined || (paper.view === 'pdf' && validReadingPosition(paper.position)));
}
export function validReadingPosition(value: unknown): value is ReadingPosition {
  if (!value || typeof value !== 'object') return false;
  const { page, total } = value as ReadingPosition;
  return Number.isInteger(page) && Number.isInteger(total) && page >= 1 && page <= total && total <= 100_000;
}

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
  paper?: ArxivPaper;
  activityEvidence?: ActivityEvidence;
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
  readingPosition?: ReadingPosition;
  readingConfirmed?: true;
  progress: { percent: number; evidence: string } | null;
}

export function validReadingSection(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 64 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export function validReadingDocument(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 180 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export function validActivityEvidence(value: unknown): value is ActivityEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as ActivityEvidence;
  return Object.keys(item).every(key => ['kind','title','subject','section','answeredItems','completedItems'].includes(key)) &&
    (item.kind === 'work' || item.kind === 'reading') && validReadingDocument(item.title) &&
    (item.subject === undefined || validReadingDocument(item.subject)) &&
    (item.section === undefined || (item.kind === 'reading' && validReadingSection(item.section))) &&
    [item.answeredItems, item.completedItems].every(items => items === undefined ||
      (item.kind === 'work' && Array.isArray(items) && items.length > 0 && items.length <= 8 && items.every(validReadingSection)));
}

export interface CheckpointHistory {
  records: ScreenCheckpoint[];
  hasMore?: true;
}
