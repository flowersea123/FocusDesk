import { parseWorkState, parseSignals, type WorkState, type WorkSignal } from './work-state.ts';
import { parseAISuggestion } from './ai-suggestion.ts';
/** Shared 1.0 read contract, with optional V0.2 work state extensions. */
export const MAX_OVERVIEW_BYTES = 4096;
export const MAX_TASKS = 10;
export const SCHEMA_VERSION = '1.0';

export type TaskStatus = 'todo' | 'done';
export const FOCUS_DURATION_MS = 25 * 60 * 1000;

export interface FocusSession {
  task_id: string;
  started_at: string;
  ends_at: string;
}

export interface Task {
  id: string;
  title: string;
  device_title?: string;
  status: TaskStatus;
  due_at: string | null;
}

export interface DailyOverview {
  schema_version: '1.0';
  revision: string;
  date: string;
  timezone: string;
  updated_at: string;
  tasks: Task[];
  focus?: FocusSession | null;
  work_state?: WorkState;
  signals?: WorkSignal[];
  ai_suggestion?: string;
}

export class OverviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverviewValidationError';
  }
}

const encoder = new TextEncoder();

function fail(message: string): never {
  throw new OverviewValidationError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  // TextEncoder replaces lone surrogates, so check before measuring UTF-8.
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) fail(`${label} contains invalid Unicode`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[\x21-\x7e]{1,64}$/.test(result)) {
    fail(`${label} must be 1-64 printable ASCII characters without spaces`);
  }
  return result;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.test(result) ||
    !isDate(result.slice(0, 10))
  ) fail(`${label} must be a valid UTC RFC 3339 timestamp ending in Z`);
  return result;
}

export function isTaskTitle(value: string): boolean;
export function isTaskTitle(value: unknown): value is string;
export function isTaskTitle(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 &&
    [...value].length <= 40 && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

export function isDeviceTaskTitle(value: string): boolean;
export function isDeviceTaskTitle(value: unknown): value is string;
export function isDeviceTaskTitle(value: unknown): boolean {
  return typeof value === 'string' && /^[\x20-\x7e]{1,40}$/.test(value) && value.trim().length > 0;
}

/** Validate the candidate DTO and return a fresh object containing known fields. */
export function parseDailyOverview(input: unknown): DailyOverview {
  const source = record(input, 'overview');
  let serialized: string;
  try {
    serialized = JSON.stringify(source);
  } catch {
    return fail('overview must be JSON serializable');
  }
  if (encoder.encode(serialized).byteLength > MAX_OVERVIEW_BYTES) {
    fail('overview exceeds 4096 UTF-8 bytes');
  }
  if (source.schema_version !== SCHEMA_VERSION) fail('unsupported schema_version');
  const revision = identifier(source.revision, 'revision');
  const date = text(source.date, 'date');
  if (!isDate(date)) fail('date must be a valid YYYY-MM-DD calendar date');
  const timezone = text(source.timezone, 'timezone');
  // Reject numeric offsets, even where Intl supports them; contract requires IANA.
  if (!timezone || encoder.encode(timezone).byteLength > 64 || /^[+-]/.test(timezone)) {
    fail('timezone must be a valid IANA timezone');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return fail('timezone must be a valid IANA timezone');
  }
  const updated_at = timestamp(source.updated_at, 'updated_at');
  if (!Array.isArray(source.tasks) || source.tasks.length > MAX_TASKS) {
    fail(`tasks must be an array containing at most ${MAX_TASKS} tasks`);
  }
  const ids = new Set<string>();
  const tasks = Array.from(source.tasks, (inputTask: unknown): Task => {
    const item = record(inputTask, 'task');
    const id = identifier(item.id, 'task.id');
    if (ids.has(id)) fail('task IDs must be unique');
    ids.add(id);
    if (!isTaskTitle(item.title)) fail('task.title must contain 1-40 Unicode code points and no line breaks or control characters');
    if (item.device_title !== undefined && !isDeviceTaskTitle(item.device_title)) {
      fail('task.device_title must be 1-40 printable ASCII characters, not blank');
    }
    if (item.status !== 'todo' && item.status !== 'done') fail('unsupported task.status');
    const due_at = item.due_at === null ? null : timestamp(item.due_at, 'task.due_at');
    return { id, title: item.title, status: item.status, due_at, ...(item.device_title !== undefined ? {device_title:item.device_title} : {}) };
  });
  const result: DailyOverview = { schema_version: SCHEMA_VERSION, revision, date, timezone, updated_at, tasks };
  if (source.work_state !== undefined) result.work_state = parseWorkState(source.work_state);
  if (source.signals !== undefined) result.signals = parseSignals(source.signals);
  if (source.ai_suggestion !== undefined) result.ai_suggestion = parseAISuggestion(source.ai_suggestion);
  if (source.focus !== undefined) {
    result.focus = null;
    if (source.focus !== null) {
      const session = record(source.focus, 'focus');
      const task_id = identifier(session.task_id, 'focus.task_id');
      const started_at = timestamp(session.started_at, 'focus.started_at');
      const ends_at = timestamp(session.ends_at, 'focus.ends_at');
      // Canonical millisecond precision keeps browser/device validation equal.
      const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      if (!canonical.test(started_at) || !canonical.test(ends_at) ||
          Date.parse(ends_at) - Date.parse(started_at) !== FOCUS_DURATION_MS) {
        fail('focus must contain canonical UTC timestamps exactly 25 minutes apart');
      }
      if (!tasks.some(task => task.id === task_id && task.status === 'todo')) {
        fail('focus.task_id must reference an unfinished task');
      }
      result.focus = { task_id, started_at, ends_at };
    }
  }
  // Object callers may provide a custom toJSON on the input. Measure the fresh
  // DTO as well so that its actual serialized output always respects the limit.
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_OVERVIEW_BYTES) {
    fail('validated overview exceeds 4096 UTF-8 bytes');
  }
  return result;
}

/** Validate body size before parsing, including whitespace in the received body. */
export function parseDailyOverviewText(body: string): DailyOverview {
  if (encoder.encode(body).byteLength > MAX_OVERVIEW_BYTES) {
    fail('overview body exceeds 4096 UTF-8 bytes');
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return fail('overview body is not valid JSON');
  }
  return parseDailyOverview(data);
}
