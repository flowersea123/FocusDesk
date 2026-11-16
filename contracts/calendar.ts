import { isDeviceTaskTitle } from './task-update.ts';

export interface CalendarItem {
  id: string;
  title: string;
  deviceTitle: string;
  plannedDate: string;
  dueDate: string | null;
  dueAt: string | null;
  source: 'manual' | 'mail' | 'canvas';
  sourceTitle?: string;
}
export interface CalendarEntry extends CalendarItem {
  status: 'scheduled' | 'waiting' | 'published' | 'done' | 'removed';
}
export interface CalendarSnapshot {
  revision: string;
  today: string;
  timezone: string;
  entries: CalendarEntry[];
}

export class CalendarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CalendarError';
    this.status = status;
  }
}

export function validCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validLabel(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && [...value].length <= max && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

export function validCalendarId(id: unknown): id is string {
  return typeof id === 'string' && /^(?:src-[\w-]{43}|cal-[\da-fA-F]{8}-(?:[\da-fA-F]{4}-){3}[\da-fA-F]{12})$/.test(id);
}

function parseDueAt(value: unknown): string | null {
  if (value === null) return null;
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d+))?Z$/.exec(value);
  if (!match || !validCalendarDay(match[1].slice(0, 10))) {
    throw new CalendarError(400, '截止时间需为准确的 UTC 时间，只有日期时请保留为空。');
  }
  const fraction = (match[2] ?? '').replace(/0+$/, '').padEnd(3, '0');
  return match[1] + '.' + fraction + 'Z';
}

export function parseCalendarItem(value: unknown): CalendarItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CalendarError(400, '请检查日历事项。');
  const row = value as Record<string, unknown>;
  const allowed = ['id', 'title', 'deviceTitle', 'plannedDate', 'dueDate', 'dueAt', 'source', 'sourceTitle'];
  if (Object.keys(row).some(key => !allowed.includes(key)) || !validCalendarId(row.id) ||
      (row.source !== 'manual' && row.source !== 'mail' && row.source !== 'canvas') ||
      (row.source === 'manual') !== row.id.startsWith('cal-')) {
    throw new CalendarError(400, '日历来源或标识无效。');
  }
  if (!validLabel(row.title, 240) || (row.sourceTitle !== undefined && !validLabel(row.sourceTitle, 300))) {
    throw new CalendarError(400, '请提供有效的事项名称和来源标题。');
  }
  if (typeof row.deviceTitle !== 'string' || !isDeviceTaskTitle(row.deviceTitle)) {
    throw new CalendarError(400, '设备短标题需为 1–40 个可打印 ASCII 字符。');
  }
  if (!validCalendarDay(row.plannedDate) || (row.dueDate !== null && !validCalendarDay(row.dueDate))) {
    throw new CalendarError(400, '请选择有效的计划日期和截止日期。');
  }
  return {
    id: row.id, title: row.title.trim(), deviceTitle: row.deviceTitle.trim(), plannedDate: row.plannedDate,
    dueDate: row.dueDate, dueAt: parseDueAt(row.dueAt), source: row.source,
    ...(row.sourceTitle === undefined ? {} : { sourceTitle: row.sourceTitle.trim() }),
  };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
export function calendarDay(ms: number, timezone: string): string {
  let format = dayFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(timezone, format);
  }
  return format.format(ms);
}
