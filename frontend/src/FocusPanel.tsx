import { useEffect, useState, type CSSProperties } from 'react';
import { FOCUS_DURATION_MS, type DailyOverview } from '../../contracts/daily-overview';
import type { FocusUpdateRequest } from '../../contracts/focus-update';
import './focus.css';

export function focusEndLabel(overview: DailyOverview) {
  return overview.focus ? new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: overview.timezone,
  }).format(new Date(overview.focus.ends_at)) : '';
}

function FocusDial({ endsAt }: { endsAt?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  const remaining = endsAt ? Math.max(0, Math.min(FOCUS_DURATION_MS, Date.parse(endsAt) - now)) : FOCUS_DURATION_MS;
  const seconds = Math.ceil(remaining / 1000);
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <div className="focus-dial" style={{ '--time-arc': `${remaining / FOCUS_DURATION_MS * 100}%` } as CSSProperties}>
    <div className="focus-dial-face">
      <span className="dial-label">{endsAt ? '剩余时间' : '专注时长'}</span>
      <span className="dial-clock" role={endsAt ? 'timer' : undefined} aria-live="off">{clock}</span>
    </div>
  </div>;
}

export default function FocusPanel({ overview, saving, preferredTaskId, onTaskSelect, onSave }: {
  overview: DailyOverview;
  saving: boolean;
  preferredTaskId?: string;
  onTaskSelect?: (taskId: string) => void;
  onSave?: (input: FocusUpdateRequest) => Promise<DailyOverview>;
}) {
  const [selected, setSelected] = useState(preferredTaskId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { setSelected(preferredTaskId); }, [preferredTaskId]);
  const tasks = overview.tasks.filter(task => task.status === 'todo');
  const focus = overview.focus;
  const selection = onTaskSelect ? preferredTaskId : selected;
  const selectedTask = tasks.find(task => task.id === (focus?.task_id ?? selection)) ?? tasks[0];
  const taskId = selectedTask?.id ?? '';

  async function submit() {
    if (!onSave || saving || pending || (!focus && !taskId)) return;
    setPending(true);
    setError(null);
    try {
      await onSave(focus ? { revision: overview.revision, action: 'stop' } :
        { revision: overview.revision, action: 'start', task_id: taskId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '专注状态保存失败，请重试。');
    } finally {
      setPending(false);
    }
  }

  return <section className="focus-panel" aria-labelledby="focus-title">
    <div className="focus-grid">
      <h2 className="focus-label" id="focus-title"><i aria-hidden="true" />{focus ? '正在专注' : '专注计时'}</h2>
      <FocusDial endsAt={focus?.ends_at} />
      {!focus && onSave && tasks.length > 1 ? <select className="focus-choice" aria-label="选择专注任务"
        title={selectedTask?.title} value={taskId} disabled={saving || pending} onChange={event => {
          const id = event.target.value;
          setSelected(id);
          onTaskSelect?.(id);
          setError(null);
        }}>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select> : <p className="focus-task">
        {selectedTask?.title ?? (overview.tasks.length ? '今天的任务已完成' : '暂无待办任务')}
      </p>}
      {focus && <p className="focus-time">至 {focusEndLabel(overview)} · {overview.timezone}</p>}
      {onSave && <div className="focus-actions">
        <button type="button" className="focus-action" disabled={saving || pending || (!focus && !taskId)} onClick={() => void submit()}>
          <i className={focus ? 'stop-icon' : 'play-icon'} aria-hidden="true" />
          {pending ? '正在更新专注…' : focus ? '结束专注' : '开始专注 · 25 分钟'}
        </button>
      </div>}
      {error && <p role="alert" className="focus-error">{error}</p>}
    </div>
  </section>;
}
