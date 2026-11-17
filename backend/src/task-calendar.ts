import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import {
  CalendarError, calendarDay, parseCalendarItem, validCalendarId,
  type CalendarEntry, type CalendarItem, type CalendarSnapshot,
} from '../../contracts/calendar.ts';
import { isTaskTitle, MAX_TASKS, type DailyOverview, type Task } from '../../contracts/daily-overview.ts';

type Row = { item: CalendarItem; phase: 'scheduled' | 'published' | 'removed' | 'cancelled' };
type State = { version: 1; rows: Row[] };
type Context = { current: DailyOverview; state: State; today: string };

function isRemoved(row: Row) { return row.phase === 'removed' || row.phase === 'cancelled'; }

/** The overview loader serializes these operations under the Hub's existing data lock. */
export function createTaskCalendar(dataPath: string, now: () => number) {
  const file = dataPath + '.calendar.json';

  async function read(): Promise<State> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.rows)) throw Error('Invalid calendar');
      const ids = new Set<string>();
      const rows = data.rows.map((row: Row) => {
        const item = parseCalendarItem(row.item);
        if (ids.has(item.id) || !['scheduled', 'published', 'removed', 'cancelled'].includes(row.phase)) throw Error('Invalid calendar row');
        ids.add(item.id);
        return { item, phase: row.phase };
      });
      return { version: 1, rows };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rows: [] };
      throw new CalendarError(503, '本机日历无法读取，已保留原文件。');
    }
  }

  async function save(state: State) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      created = false;
    } catch {
      throw new CalendarError(503, '本机日历保存失败，请检查数据目录。');
    } finally {
      if (created) await unlink(temporary).catch(() => undefined);
    }
  }

  function snapshot({ current, state, today }: Context): CalendarSnapshot {
    const entries = state.rows.map(({ item, phase }): CalendarEntry => {
      let status: CalendarEntry['status'] = phase === 'cancelled' ? 'removed' : phase;
      if (phase === 'published') {
        const task = current.tasks.find(task => task.id === item.id);
        if (!task) status = 'removed';
        else if (task.status === 'done') status = 'done';
      } else if (phase === 'scheduled' && item.plannedDate <= today) {
        status = 'waiting';
      }
      return { ...item, status };
    });
    const revision = createHash('sha256').update(JSON.stringify([today, current.timezone, entries])).digest('hex');
    return { revision, today, timezone: current.timezone, entries };
  }

  async function reconcile(
    current: DailyOverview,
    fits: (tasks: Task[], date: string) => boolean,
    publish: (tasks: Task[], date: string) => Promise<DailyOverview>,
  ): Promise<Context> {
    const state = await read();
    const today = calendarDay(now(), current.timezone);
    let tasks = [...current.tasks];
    let changed = false;
    let date = current.date;
    const due: Row[] = [];
    for (const row of state.rows) {
      const { item, phase } = row;
      const task = tasks.find(task => task.id === item.id);
      if (phase === 'published') {
        // Removal from the ordinary task editor is a user decision that survives mail retries.
        if (!task) { row.phase = 'removed'; changed = true; }
      } else if (phase === 'scheduled' && item.plannedDate <= today) {
        due.push(row);
      } else if (task?.status === 'todo' && task.id !== current.focus?.task_id) {
        tasks = tasks.filter(task => task.id !== item.id);
      }
    }

    due.sort((a, b) => a.item.plannedDate.localeCompare(b.item.plannedDate));
    let position = 0;
    for (const row of due) {
      const { item } = row;
      const existing = tasks.find(task => task.id === item.id);
      if (existing?.status === 'done') {
        row.phase = 'published';
        changed = true;
        continue;
      }
      if (!existing && tasks.length >= MAX_TASKS) continue;
      const trial = tasks.filter(task => task.id !== item.id);
      const useOriginal = item.source === 'manual' && isTaskTitle(item.title);
      trial.splice(position, 0, { id: item.id, title: useOriginal ? item.title : item.deviceTitle,
        ...(useOriginal && item.title !== item.deviceTitle ? { device_title:item.deviceTitle } : {}), status: 'todo', due_at: item.dueAt });
      if (!fits(trial, today)) continue;
      tasks = trial;
      position++;
      row.phase = 'published';
      changed = true;
      date = today;
    }

    if (date !== current.date || JSON.stringify(tasks) !== JSON.stringify(current.tasks)) current = await publish(tasks, date);
    // If stopped between writing the two files, the same stable task ID is adopted on the next read.
    if (changed) await save(state);
    return { current, state, today };
  }

  async function prepareTasks({ state, today, current }: Context, proposed: Task[], restoreTaskId?: string) {
    if (restoreTaskId !== undefined) {
      const unchanged = proposed.filter(task => task.id !== restoreTaskId);
      if (proposed.length !== current.tasks.length + 1 || JSON.stringify(unchanged) !== JSON.stringify(current.tasks)) {
        throw new CalendarError(409, '撤销删除只能恢复刚加入的这一项，请刷新任务清单。');
      }
    }
    let restored: Row | undefined;
    for (const row of state.rows) {
      const { item, phase } = row;
      if (item.id === restoreTaskId) {
        if (phase !== 'removed' || item.plannedDate > today) {
          throw new CalendarError(409, '这项安排已更改，请刷新日历。');
        }
        restored = row;
        continue;
      }
      if (!isRemoved(row) && !(phase === 'scheduled' && item.plannedDate > today)) continue;
      const next = proposed.find(task => task.id === item.id);
      const previous = current.tasks.find(task => task.id === item.id);
      if (next && (!previous || (previous.status === 'done' && next.status === 'todo'))) {
        throw new CalendarError(409, '此来源已移除或安排在未来日期，请刷新日历。');
      }
    }
    if (restored) {
      // Only a successful task-file write makes this visible. On a crash before that write,
      // reconciliation sees the ID still missing and returns the row to its tombstone.
      restored.phase = 'published';
      await save(state);
    }
  }

  async function mutate(ctx: Context, method: 'PUT' | 'DELETE', input: Record<string, unknown>) {
    const fields = method === 'PUT' ? ['revision', 'entry', 'restore'] : ['revision', 'id'];
    if (typeof input.revision !== 'string' || !input.revision || Object.keys(input).some(key => !fields.includes(key)) ||
        (input.restore !== undefined && input.restore !== true)) throw new CalendarError(400, '日历请求格式无效。');
    const item = method === 'PUT' ? parseCalendarItem(input.entry) : undefined;
    const id = item?.id ?? input.id;
    if (!validCalendarId(id)) throw new CalendarError(400, '事项标识无效。');
    const row = ctx.state.rows.find(row => row.item.id === id);
    const task = ctx.current.tasks.find(task => task.id === id);
    if (item?.dueAt && item.dueDate && calendarDay(Date.parse(item.dueAt), ctx.current.timezone) !== item.dueDate) {
      throw new CalendarError(400, '截止时间与本地截止日期不一致。');
    }

    if (item && row && JSON.stringify(row.item) === JSON.stringify(item) && (!isRemoved(row) || !input.restore)) return;
    if (!item && (!row || isRemoved(row))) return;
    if (input.revision !== snapshot(ctx).revision) throw new CalendarError(409, '日历已更新，请重新读取后重试。');
    if (item && row && isRemoved(row) && !input.restore) throw new CalendarError(409, '该来源已被移除，需明确恢复。');
    if (task?.status === 'done') throw new CalendarError(409, '此事项已完成，请先在任务列表恢复待办。');
    if (ctx.current.focus?.task_id === id && (!item || item.plannedDate > ctx.today)) {
      throw new CalendarError(409, '此事项正在专注，请结束计时后再改期或移除。');
    }

    const updated: Row = item ? { item, phase: 'scheduled' } : { item: row!.item, phase: 'cancelled' };
    const rows = row ? ctx.state.rows.map(other => other === row ? updated : other) : [...ctx.state.rows, updated];
    // Commit the desired schedule first, so an interrupted publication or removal can finish on restart.
    await save({ version: 1, rows });
  }

  return { reconcile, snapshot, mutate, prepareTasks };
}
