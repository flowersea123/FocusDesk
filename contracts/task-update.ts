import {
  MAX_OVERVIEW_BYTES,
  OverviewValidationError,
  parseDailyOverview,
  type Task,
} from './daily-overview.ts';

export interface TaskUpdateRequest {
  revision: string;
  tasks: Task[];
  restoreTaskId?: string;
}

export function isDeviceTaskTitle(value: string): boolean {
  return /^[\x20-\x7e]{1,40}$/.test(value) && value.trim().length > 0;
}

/** Writable profile: task edits only; date/timezone remain server-owned. */
export function parseTaskUpdateRequest(input: unknown): TaskUpdateRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OverviewValidationError('Task update must be an object');
  }
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some(key => key !== 'revision' && key !== 'tasks' && key !== 'restoreTaskId')) {
    throw new OverviewValidationError('Task updates accept revision, tasks and an optional restoreTaskId');
  }
  const normalized = parseDailyOverview({
    schema_version: '1.0', revision: source.revision,
    date: '2000-01-01', timezone: 'UTC', updated_at: '2000-01-01T00:00:00Z',
    tasks: source.tasks,
  });
  if (normalized.tasks.some(task => !isDeviceTaskTitle(task.title))) {
    throw new OverviewValidationError('Task titles must be 1-40 printable ASCII characters, not blank');
  }
  const { restoreTaskId } = source;
  if (restoreTaskId !== undefined && (typeof restoreTaskId !== 'string' || !normalized.tasks.some(task => task.id === restoreTaskId))) {
    throw new OverviewValidationError('restoreTaskId must identify the restored row in the task list');
  }
  return { revision: normalized.revision, tasks: normalized.tasks, ...(restoreTaskId === undefined ? {} : { restoreTaskId }) };
}

export function parseTaskUpdateText(body: string): TaskUpdateRequest {
  if (new TextEncoder().encode(body).byteLength > MAX_OVERVIEW_BYTES) {
    throw new OverviewValidationError('Task update exceeds 4096 bytes');
  }
  let data: unknown;
  try { data = JSON.parse(body); }
  catch { throw new OverviewValidationError('Task update is not valid JSON'); }
  return parseTaskUpdateRequest(data);
}
