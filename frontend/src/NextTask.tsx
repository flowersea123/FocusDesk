import { workspaceClock } from './data/workspace-clock';
import { useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import type { FocusReview } from '../../contracts/focus-review';

interface NextAction {
  task?: Task;
  appName?: string;
  action: string;
  reason: string;
}

export function nextAction(overview: DailyOverview, review: FocusReview | null): NextAction | null {
  const pending = overview.tasks.filter(task => task.status === 'todo');
  const observations = review?.observations ?? [];
  const time = (iso: string) => workspaceClock(review?.timezone ?? overview.timezone).format(new Date(iso));
  const recent = [
    ...observations.filter(o => o.taskId || o.nextStep?.trim()).map(o => ({
      id: o.taskId, at: o.at, kind: '记录', observation: o,
    })),
    ...(review?.sessions ?? []).map(s => ({ id: s.taskId, at: s.to, kind: '计时', observation: undefined })),
  ].filter(item => item.id ? pending.some(task => task.id === item.id) : pending.length === 0)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  const active = pending.find(task => task.id === overview.focus?.task_id);
  if (!pending.length && recent && !recent.id && recent.observation?.nextStep) {
    const latest = recent.observation;
    return { action: latest.nextStep!, reason: time(latest.at) + ' ' + (latest.appName ?? '屏幕记录') + ' · ' + latest.summary };
  }
  if (!pending.length && !recent && review) {
    const latestSpan = review.appSessions?.at(-1);
    const latestShot = observations.filter(o => o.appName).at(-1);
    const useSpan = latestSpan && (!latestShot || Date.parse(latestSpan.to) > Date.parse(latestShot.at));
    const appName = useSpan ? latestSpan.appName : latestShot?.appName;
    const last = useSpan ? latestSpan.to : latestShot?.at;
    const appEvidence = appName && observations.filter(o => o.appName === appName).at(-1);
    if (appName && last && (!appEvidence || !appEvidence.taskId)) {
      return { appName, action: '回看 ' + appName + ' 的最近活动',
        reason: time(last) + (useSpan ? ' 记录到该应用在前台。' : ' · ' + latestShot!.summary) };
    }
  }
  if (!pending.length) return null;
  const previous = pending.find(task => task.id === recent?.id);
  const due = pending.filter(task => task.due_at).sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!))[0];
  const task = active ?? previous ?? due ?? pending[0];
  const checkpoint = observations.filter(o => o.taskId === task.id).at(-1);
  const deadline = task.due_at && workspaceClock(overview.timezone, true).format(new Date(task.due_at));
  const reason = active ? '正在专注' : previous ? time(recent.at) + (recent.kind === '记录' ? ' 有这项任务的屏幕记录' : ' 专注过这项任务') :
    deadline ? deadline + ' 截止 · 待办中最早' : '清单中排在最前的待办';
  return { task, reason, action: checkpoint?.nextStep?.trim() || checkpoint?.summary || '' };
}

export default function NextTask({ overview, next, saving, onStart, onInspect, onHistory, onApp }: {
  overview: DailyOverview; next: NextAction | null; saving: boolean;
  onStart?(task: Task): Promise<void>; onInspect(task: Task): void; onHistory(): void; onApp(app: string): void;
}) {
  const [failure, setFailure] = useState('');
  const task = next?.task;
  const running = !!task && task.id === overview.focus?.task_id;
  const canStart = !!onStart && !running;
  async function start() {
    if (!task || !onStart || saving) return;
    setFailure('');
    try { await onStart(task); } catch (error) { setFailure(error instanceof Error ? error.message : '专注计时暂时无法开始。'); }
  }
  return <section className="next-task-card" aria-labelledby="next-task-title">
    <h2 id="next-task-title" lang="en">Up Next</h2>
    {next ? <>
      <strong className="next-task-name">{task?.title ?? next.action}</strong>
      {task && next.action && <p className="next-task-description">{next.action}</p>}
      <small className="next-task-reason">{next.reason}</small>
      {task ? <button type="button" className="next-task-action" disabled={saving}
        onClick={() => canStart ? void start() : onInspect(task)}>{canStart ? '专注这项任务 · 25 分钟' : '查看任务详情'}</button> :
        <button type="button" className="next-task-action" onClick={() => next.appName ? onApp(next.appName) : onHistory()}>{next.appName ? '查看应用活动' : '打开记录时间线'}</button>}
    </> : <p className="next-task-description">{overview.tasks.length ? '清单里的任务都已完成。' : '添加一项待办，或开始记录当前工作，下一步会显示在这里。'}</p>}
    {failure && <p role="alert">{failure}</p>}
  </section>;
}
