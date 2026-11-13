import { useState } from 'react';
import type { DailyOverview } from '../../contracts/daily-overview';
import type { FocusUpdateRequest } from '../../contracts/focus-update';
import './focus.css';

export function focusEndLabel(overview: DailyOverview) {
  return overview.focus ? new Intl.DateTimeFormat('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: overview.timezone,
  }).format(new Date(overview.focus.ends_at)) : '';
}

export default function FocusPanel({ overview, saving, onSave }: {
  overview: DailyOverview;
  saving: boolean;
  onSave: (input: FocusUpdateRequest) => Promise<DailyOverview>;
}) {
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tasks = overview.tasks.filter(task => task.status === 'todo');
  const taskId = tasks.some(task => task.id === selected) ? selected : tasks[0]?.id ?? '';
  const focusedTask = overview.tasks.find(task => task.id === overview.focus?.task_id);
  async function submit() {
    if (saving || pending) return;
    setPending(true); setError(null);
    try {
      await onSave(overview.focus ? { revision: overview.revision, action: 'stop' } :
        { revision: overview.revision, action: 'start', task_id: taskId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '专注状态保存失败，请重试。');
    } finally { setPending(false); }
  }
  return <section className={`focus-panel${overview.focus ? ' is-focusing' : ''}`} aria-labelledby="focus-title">
    <div><p className="eyebrow">ONE THING AT A TIME</p><h3 id="focus-title">{overview.focus ? '正在专注' : 'Focus Mode'}</h3></div>
    {overview.focus ? <>
      <strong className="focus-task">{focusedTask?.title}</strong>
      <p className="focus-time">25 分钟 · 结束于 {focusEndLabel(overview)} <span>({overview.timezone})</span></p>
    </> : <>
      <label htmlFor="focus-task">选择一件事，专注 25 分钟</label>
      <select id="focus-task" value={taskId} disabled={saving || pending || !tasks.length}
        onChange={event => { setSelected(event.target.value); setError(null); }}>
        {tasks.length ? tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>) :
          <option value="">暂无未完成任务</option>}
      </select>
    </>}
    <button type="button" className="focus-action" disabled={saving || pending || (!overview.focus && !taskId)} onClick={() => void submit()}>
      {pending ? '正在更新专注…' : overview.focus ? '结束专注' : '开始专注 · 25 分钟'}
    </button>
    {error && <p role="alert" className="focus-error">{error}</p>}
    <p className="focus-hint">到时恢复总览，任务仍需手动标记完成。电子纸会在下次同步后更新。</p>
  </section>;
}
