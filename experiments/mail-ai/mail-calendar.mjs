import { createHash } from 'node:crypto';
import { calendarDay } from '../../contracts/calendar.ts';
import { isDeviceTaskTitle } from '../../contracts/task-update.ts';
import { beijingMinute, localOrigin } from './analyze.mjs';
import { sourceTaskId, validPlanDate } from './task-import.mjs';

function compact(text, length) {
  return [...String(text ?? '').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, length).join('');
}

// Old histories may have several review-only actions extracted from the same sentence.
export function planChoices(row) {
  const actions = row.actions.length ? row.actions : [{ sourceKey: 'mail:' + row.id + ':read', title: typeof row.subject === 'string' && isDeviceTaskTitle(row.subject.slice(0, 40)) ? row.subject.slice(0, 40) : 'Read email', status: 'review' }];
  const seen = new Set();
  return actions.map((action, index) => {
    const key = action.sourceKey || 'mail:' + row.id + ':action:' + index;
    const sourceKey = seen.has(key) ? key + ':action:' + index : key;
    seen.add(key);
    const sourceTitle = compact(row.subject, 300);
    const deviceTitle = typeof action.title === 'string' && isDeviceTaskTitle(action.title) ? action.title : 'Read email';
    const title = compact(actions.length > 1 && sourceTitle ? sourceTitle + ' · ' + (action.title || index + 1) :
      sourceTitle || action.title || '阅读邮件', 240);
    const verified = action.verified ?? (action.status !== 'review' && !!action.dueAt);
    const dueAt = verified ? action.dueAt || null : null;
    const dueDate = verified ? action.dueDate || (dueAt && beijingMinute(dueAt).slice(0, 10)) : null;
    return { id: sourceTaskId(sourceKey), sourceKey, title, deviceTitle, sourceTitle, dueDate, dueAt,
      status: action.status, reason: action.reason || null };
  });
}

export function calendarDeadline(choice, timezone) {
  if (!choice.dueAt || !timezone) return choice.dueDate;
  return calendarDay(Date.parse(choice.dueAt), timezone);
}

export function planRevision(entry) {
  if (!entry) return 'none';
  return createHash('sha256').update(JSON.stringify([entry.id, entry.plannedDate, entry.dueDate, entry.dueAt, entry.title,
    entry.deviceTitle, entry.status, entry.sourceTitle])).digest('hex');
}

export async function readCalendar(hub, fetcher = fetch) {
  const response = await fetcher(localOrigin(hub) + '/api/v1/calendar', {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8_000),
  });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.entries) || typeof data.revision !== 'string') throw Error(data.error || '无法读取本机日历。');
  return data;
}

/** Automatic delivery respects a user's reschedule, completion, or removal. A manual plan updates the same entry. */
export async function saveMailPlan({ hub, sourceKey, title, deviceTitle, sourceTitle, dueAt = null, dueDate = null,
  plannedDate, automatic = false, restore = false, expectedRevision, fetcher = fetch }) {
  if (!sourceKey || !validPlanDate(plannedDate) || (dueDate !== null && !validPlanDate(dueDate))) throw Error('请选择有效的计划日和截止日。');
  if (typeof deviceTitle !== 'string' || !isDeviceTaskTitle(deviceTitle)) throw Error('请输入 1–40 个可打印英文字符作为设备短标题。');
  const origin = localOrigin(hub), id = sourceTaskId(sourceKey);
  for (let attempt = 0; attempt < 3; attempt++) {
    const calendar = await readCalendar(origin, fetcher);
    const existing = calendar.entries.find(entry => entry.id === id);
    if (existing && automatic) return { status: 'existing', entry: existing };
    const revision = planRevision(existing);
    if (!automatic && expectedRevision !== undefined && expectedRevision !== revision) throw Object.assign(
      Error('其他窗口已修改这项安排。请读取最新安排后再保存。'), { status: 409, current: existing ?? null, planRevision: revision });
    expectedRevision = revision;
    if (existing?.status === 'done') throw Error('该事项已完成，请先在今日任务中恢复待办。');
    if (existing?.status === 'removed' && !restore) throw Error('这项安排已移除，请选择重新安排。');
    const localDueDate = calendarDeadline({ dueAt, dueDate }, calendar.timezone);
    if (automatic && !dueAt && localDueDate < calendar.today) return { status: 'expired', reason: '截止日期已过。' };
    const originalTitle = compact(sourceTitle, 300);
    const entry = { id, title: compact(title, 240), deviceTitle, plannedDate: automatic ? localDueDate : plannedDate, dueDate: localDueDate, dueAt,
      source: sourceKey.startsWith('canvas:') ? 'canvas' : 'mail', ...(originalTitle ? { sourceTitle: originalTitle } : {}) };
    if (!entry.title) throw Error('请填写事项标题。');
    const response = await fetcher(origin + '/api/v1/calendar', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10_000), body: JSON.stringify({ revision: calendar.revision, entry, ...(restore === true ? { restore: true } : {}) }) });
    const data = await response.json();
    if (response.status === 409 && attempt < 2) continue;
    if (!response.ok) throw Error(typeof data.error === 'string' ? data.error : '本机日历暂时无法保存。');
    const saved = data.entries?.find(item => item.id === id);
    if (!saved) throw Error('本机日历没有返回保存的事项。');
    return { status: existing ? 'existing' : 'added', entry: saved, planRevision: planRevision(saved) };
  }
}

export function selectedPlan(choice, input) {
  if (!validPlanDate(input.plannedDate)) throw Error('请选择有效的计划日。');
  const dueDate = choice.dueDate || input.dueDate || null;
  if (dueDate && !validPlanDate(dueDate)) throw Error('请选择有效的截止日。');
  return { ...choice, plannedDate: input.plannedDate, dueDate, deviceTitle: input.deviceTitle ?? choice.deviceTitle,
    title: input.title ?? choice.title, restore: input.restore === true, expectedRevision: input.expectedRevision };
}
