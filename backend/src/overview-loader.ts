import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_OVERVIEW_BYTES, FOCUS_DURATION_MS, OverviewValidationError, parseDailyOverview, type DailyOverview, type FocusSession, type Task } from '../../contracts/daily-overview.ts';
import { parseTaskUpdateRequest, type TaskUpdateRequest } from '../../contracts/task-update.ts';
import { parseFocusUpdateRequest, type FocusUpdateRequest } from '../../contracts/focus-update.ts';
import { parseWorkStateUpdateRequest, type WorkStateUpdateRequest } from '../../contracts/work-state.ts';
import { parseAISuggestionUpdateRequest, type AISuggestionUpdateRequest } from '../../contracts/ai-suggestion.ts';
import { ImportSourceError, readDesktopFile, validateDesktopSource, type DesktopSource } from './desktop-data.ts';
import { createTaskCalendar } from './task-calendar.ts';

export class SourceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

export class RevisionConflictError extends Error {
  constructor() {
    super('Tasks changed since this draft was read. Reload and review before saving.');
    this.name = 'RevisionConflictError';
  }
}

export class FocusActiveError extends Error {
  constructor() { super('A focus session is already active. End it before starting another.'); }
}

// Narrow filesystem seam makes persistence failures testable without changing
// real data or depending on platform-specific permission tricks.
interface PersistenceOperations {
  openTemporary?: typeof open;
  replace?: typeof rename;
  now?: () => number;
}

/** Read on every request; cache only metadata for unchanged valid content. */
export function createOverviewLoader(dataPath: string, persistence: PersistenceOperations = {}) {
  const calendar = createTaskCalendar(dataPath, persistence.now ?? Date.now);
  let previous: DailyOverview | undefined;
  let queue: Promise<void> = Promise.resolve();
  let closing = false;

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new SourceError('SERVICE_STOPPING', 'FocusDesk is stopping.'));
    const pending = queue.then(job);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function read(): Promise<DailyOverview> {
    let source: unknown;
    let updatedAt: string;
    try {
      const file = await open(dataPath, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new SourceError('INVALID_TASK_SOURCE', 'Task source must be a regular file.');
        if (info.size > MAX_OVERVIEW_BYTES) throw new SourceError('TASK_SOURCE_TOO_LARGE', 'Task source exceeds 4096 bytes.');
        const buffer = Buffer.alloc(MAX_OVERVIEW_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        if (bytes > MAX_OVERVIEW_BYTES) throw new SourceError('TASK_SOURCE_TOO_LARGE', 'Task source exceeds 4096 bytes.');
        source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
        updatedAt = info.mtime.toISOString();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new SourceError('INVALID_TASK_SOURCE', 'Task source must contain valid UTF-8 JSON.');
      }
      throw new SourceError('TASK_SOURCE_UNAVAILABLE', 'Task source could not be read.');
    }

    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new SourceError('INVALID_TASK_SOURCE', 'Task source must contain date, timezone, and tasks.');
    }
    const input = source as Record<string, unknown>;
    if (Object.keys(input).some(key => !['date', 'timezone', 'tasks', 'focus', 'work_state', 'signals', 'ai_suggestion'].includes(key))) {
      throw new SourceError('INVALID_TASK_SOURCE', 'Task source accepts date, timezone, tasks, and optional focus, work_state, signals, ai_suggestion.');
    }
    let validated: DailyOverview;
    try {
      validated = parseDailyOverview({ schema_version: '1.0', revision: 'validation', date: input.date, timezone: input.timezone, updated_at: updatedAt, tasks: input.tasks, focus: input.focus, work_state: input.work_state, signals: input.signals, ai_suggestion: input.ai_suggestion });
    } catch {
      throw new SourceError('INVALID_TASK_SOURCE', 'Task source does not satisfy the DailyOverview contract.');
    }
    if (!['Asia/Shanghai', 'UTC'].includes(validated.timezone)) {
      throw new SourceError('UNSUPPORTED_DEVICE_TIMEZONE', 'This device demo supports only Asia/Shanghai or UTC.');
    }
    const now = (persistence.now ?? Date.now)();
    const focus = validated.focus && Date.parse(validated.focus.started_at) <= now && now < Date.parse(validated.focus.ends_at) ? validated.focus : null;
    validated.focus = focus;
    // Idle content keeps the original task-only revision algorithm.
    const normalized = JSON.stringify({ date: validated.date, timezone: validated.timezone, tasks: validated.tasks, ...(focus ? { focus } : {}), ...optionalFields(validated) });
    const revision = createHash('sha256').update(normalized).digest('hex');
    if (previous?.revision === revision) return parseDailyOverview(previous);
    try {
      previous = parseDailyOverview({ ...validated, revision });
    } catch {
      throw new SourceError('TASK_SOURCE_TOO_LARGE', 'Published overview exceeds the response limit.');
    }
    return parseDailyOverview(previous);
  }

  function optionalFields(overview: DailyOverview): Pick<DesktopSource, 'work_state' | 'signals' | 'ai_suggestion'> {
    return {
      ...(overview.work_state !== undefined ? { work_state: overview.work_state } : {}),
      ...(overview.signals !== undefined ? { signals: overview.signals } : {}),
      ...(overview.ai_suggestion !== undefined ? { ai_suggestion: overview.ai_suggestion } : {}),
    };
  }

  async function persist(current: DailyOverview, tasks: Task[], focus: FocusSession | null, replacement?: { source: DesktopSource; backupsPath?: string }): Promise<DailyOverview> {
    const source = replacement?.source ?? { date: current.date, timezone: current.timezone, tasks, ...(focus ? { focus } : {}), ...optionalFields(current) };
    // Validate the complete replacement independently so an old field omitted by
    // a confirmed import cannot leak in from the currently loaded source.
    parseDailyOverview({ schema_version: '1.0', revision: current.revision, updated_at: current.updated_at, ...source });
    const body = JSON.stringify(source, null, 2) + '\n';
    if (Buffer.byteLength(body) > MAX_OVERVIEW_BYTES) {
      throw new OverviewValidationError('Updated task source would exceed 4096 bytes.');
    }
    const temporary = path.join(path.dirname(dataPath), `.${path.basename(dataPath)}.focusdesk-${randomUUID()}.tmp`);
    let created = false;
    try {
      const file = await (persistence.openTemporary ?? open)(temporary, 'wx', 0o600);
      created = true;
      try { await file.writeFile(body, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      const latest = await read();
      if (latest.revision !== current.revision) throw new RevisionConflictError();
      if (replacement?.backupsPath) {
        await mkdir(replacement.backupsPath, { recursive: true, mode: 0o700 });
        const backup = path.join(replacement.backupsPath, `${path.basename(dataPath)}.pre-import-${randomUUID()}.json`);
        const original = await readDesktopFile(dataPath);
        const backupFile = await open(backup, 'wx', 0o600);
        let complete = false;
        try { await backupFile.writeFile(original.bytes); await backupFile.sync(); complete = true; }
        finally {
          await backupFile.close();
          if (!complete) await unlink(backup).catch(() => undefined);
        }
        const afterBackup = await read();
        if (afterBackup.revision !== current.revision) throw new RevisionConflictError();
      }
      await (persistence.replace ?? rename)(temporary, dataPath);
      created = false;
      return await read();
    } catch (error) {
      if (error instanceof RevisionConflictError || error instanceof SourceError) throw error;
      throw new SourceError('TASK_SOURCE_WRITE_FAILED', 'Changes could not be saved; check the task file and retry.');
    } finally {
      if (created) {
        try { await unlink(temporary); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new SourceError('TASK_SOURCE_WRITE_FAILED', 'Temporary task file could not be removed.');
          }
        }
      }
    }
  }

  async function calendarContext() {
    const current = await read();
    function sourceFor(tasks: Task[], date: string): DesktopSource {
      return { date, timezone: current.timezone, tasks, ...(current.focus ? { focus: current.focus } : {}), ...optionalFields(current) };
    }
    return calendar.reconcile(current, (tasks, date) => {
      try { parseDailyOverview({ ...current, tasks, date }); }
      catch { return false; }
      return Buffer.byteLength(JSON.stringify(sourceFor(tasks, date), null, 2) + '\n') <= MAX_OVERVIEW_BYTES;
    }, (tasks, date) => persist(current, tasks, current.focus ?? null, { source: sourceFor(tasks, date) }));
  }
  async function readCurrent() { return (await calendarContext()).current; }

  return {
    /** Stop accepting new work; resolve only after accepted writes settle. */
    close(): Promise<void> { closing = true; return queue; },
    drain(): Promise<void> { return queue; },
    load(): Promise<DailyOverview> {
      return enqueue(readCurrent);
    },
    readCalendar() { return enqueue(async () => calendar.snapshot(await calendarContext())); },
    updateCalendar(method: 'PUT' | 'DELETE', body: Record<string, unknown>) {
      const input = structuredClone(body);
      return enqueue(async () => {
        await calendar.mutate(await calendarContext(), method, input);
        return calendar.snapshot(await calendarContext());
      });
    },
    update(input: TaskUpdateRequest): Promise<DailyOverview> {
      // Copy and validate before enqueueing so callers cannot mutate a draft
      // while another read/write is ahead of it in this process's queue.
      const update = parseTaskUpdateRequest(input);
      return enqueue(async () => {
        const ctx = await calendarContext();
        const current = ctx.current;
        if (update.revision !== current.revision) throw new RevisionConflictError();
        await calendar.prepareTasks(ctx, update.tasks, update.restoreTaskId);
        if (JSON.stringify(update.tasks) === JSON.stringify(current.tasks)) return current;
        const focus = current.focus && update.tasks.some(task => task.id === current.focus!.task_id && task.status === 'todo') ? current.focus : null;
        const result = await persist(current, update.tasks, focus);
        return ctx.state.rows.length ? readCurrent() : result;
      });
    },
    updateFocus(input: FocusUpdateRequest): Promise<DailyOverview> {
      const update = parseFocusUpdateRequest(input);
      return enqueue(async () => {
        const current = await readCurrent();
        if (update.revision !== current.revision) throw new RevisionConflictError();
        if (update.action === 'stop') return current.focus ? persist(current, current.tasks, null) : current;
        if (current.focus) throw new FocusActiveError();
        if (!current.tasks.some(task => task.id === update.task_id && task.status === 'todo')) {
          throw new OverviewValidationError('Choose an unfinished task from the saved overview.');
        }
        const now = (persistence.now ?? Date.now)();
        const focus = { task_id: update.task_id, started_at: new Date(now).toISOString(), ends_at: new Date(now + FOCUS_DURATION_MS).toISOString() };
        return persist(current, current.tasks, focus);
      });
    },
    updateWorkState(input: WorkStateUpdateRequest): Promise<DailyOverview> {
      const update = parseWorkStateUpdateRequest(input);
      return enqueue(async () => {
        const current = await readCurrent();
        if (update.revision !== current.revision) throw new RevisionConflictError();
        if (JSON.stringify(update.work_state) === JSON.stringify(current.work_state) &&
            JSON.stringify(update.signals) === JSON.stringify(current.signals)) return current;
        const source: DesktopSource = {
          date: current.date, timezone: current.timezone, tasks: current.tasks,
          ...(current.focus ? { focus: current.focus } : {}),
          ...optionalFields(current),
          work_state: update.work_state, signals: update.signals,
        };
        return persist(current, current.tasks, current.focus ?? null, { source });
      });
    },
    updateAISuggestion(input: AISuggestionUpdateRequest): Promise<DailyOverview> {
      const update = parseAISuggestionUpdateRequest(input);
      return enqueue(async () => {
        const current = await readCurrent();
        if (update.revision !== current.revision) throw new RevisionConflictError();
        if (update.ai_suggestion === (current.ai_suggestion ?? '')) return current;
        const source: DesktopSource = {
          date: current.date, timezone: current.timezone, tasks: current.tasks,
          ...(current.focus ? { focus: current.focus } : {}),
          ...optionalFields(current), ai_suggestion: update.ai_suggestion,
        };
        return persist(current, current.tasks, current.focus ?? null, { source });
      });
    },
    importSource(source: unknown, options: { revision: string; confirmed: boolean; backupsPath: string }): Promise<DailyOverview> {
      const candidate = validateDesktopSource(source);
      if (options.confirmed !== true) return Promise.reject(new ImportSourceError('IMPORT_CONFIRMATION_REQUIRED', 'Confirm the preview before importing tasks.'));
      if (typeof options.backupsPath !== 'string' || !options.backupsPath.trim()) return Promise.reject(new ImportSourceError('IMPORT_BACKUP_UNAVAILABLE', 'A backup directory is required.'));
      return enqueue(async () => {
        const ctx = await calendarContext();
        const current = ctx.current;
        if (options.revision !== current.revision) throw new RevisionConflictError();
        await calendar.prepareTasks(ctx, candidate.tasks);
        const result = await persist(current, candidate.tasks, candidate.focus ?? null, { source: candidate, backupsPath: path.resolve(options.backupsPath) });
        return ctx.state.rows.length ? readCurrent() : result;
      });
    },
  };
}
