import { useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import './epaper-preview.css';

const sampleTasks: Task[] = [
  'Finish project proposal', 'Review presentation', 'Read 10 pages',
  'Prepare tomorrow’s outline', 'Organize research notes', 'Reply to project feedback',
].map((title, index) => ({ id: `preview-${index}`, title, status: 'todo', due_at: null }));

export default function EpaperPreview({ overview, draft }: { overview: DailyOverview | null; draft: boolean }) {
  const [sample, setSample] = useState(false);
  const tasks = sample ? sampleTasks : overview?.tasks ?? [];
  const pending = tasks.filter(task => task.status === 'todo');
  const focus = sample ? null : overview?.focus;
  const priority = pending.find(task => task.id === focus?.task_id) ?? pending[0];
  const ordered = priority ? [priority, ...pending.filter(task => task.id !== priority.id)] : [];
  const visible = ordered.slice(0, 5);
  const hidden = Math.max(0, ordered.length - visible.length);
  const date = overview?.date ?? '2026-11-12';
  const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`)).toUpperCase();
  const progress = `${tasks.filter(task => task.status === 'done').length} / ${tasks.length} DONE`;
  const focusLabel = focus && priority?.id === focus.task_id
    ? `FOCUS - UNTIL ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: overview?.timezone }).format(new Date(focus.ends_at))}`
    : '';
  const emptyLabel = tasks.length ? 'All tasks done' : 'No tasks for today';
  const recommendation = (overview?.ai_suggestion ?? (sample ? 'Draft the outline, then focus for 25 min.' : '')).trim() || 'No suggestion yet.';
  const available = Boolean(overview || sample);
  const transcript = available ? ['FOCUSDESK', dateLabel, 'Tasks', progress, focusLabel,
    ...visible.map(task => task.title), !visible.length && emptyLabel, hidden && `+${hidden} more`,
    'AI RECOMMENDATION', recommendation].filter(Boolean).join(' ') : '';
  return <section className="preview-card" aria-labelledby="preview-title">
    <div className="section-heading"><div><p className="eyebrow">ON YOUR DESK</p><h2 id="preview-title">E-paper preview</h2></div><span className="dimension-label">400 × 300</span></div>
    <div className="preview-source-options" role="group" aria-label="预览内容">
      <button type="button" aria-pressed={!sample} onClick={() => setSample(false)}>当前任务</button>
      <button type="button" aria-pressed={sample} onClick={() => setSample(true)}>多任务示例</button>
    </div>
    <div className="device-stage"><div className="device-frame">
      <div className="paper-design" role="img" aria-label="400 × 300 e-paper preview" aria-describedby="preview-transcript"
        data-width="400" data-height="300" data-source-revision={overview?.revision ?? ''} data-preview-mode={sample ? 'sample' : 'workspace'}>
        {available ? <div className="paper-layout" aria-hidden="true">
          <div className="paper-heading"><strong>FOCUSDESK</strong><span>{dateLabel}</span></div>
          <div className="paper-summary"><strong>Tasks</strong><span>{progress}</span></div>
          {focusLabel && <div className="paper-focus-caption">{focusLabel}</div>}
          <div className="paper-tasks">{visible.map((task, index) => <div className={`paper-task${index === 0 ? ' is-current' : ''}`} key={task.id}>
            <span className="paper-task-check" /><span className="preview-task-title" title={task.title}>{task.title}</span>
          </div>)}{!visible.length && <p className="paper-empty">{emptyLabel}</p>}</div>
          {hidden > 0 && <div className="paper-more">+{hidden} more</div>}
          <div className="paper-recommendation"><strong>AI RECOMMENDATION</strong><p>{recommendation}</p></div>
        </div> : <div className="paper-waiting">Waiting for work state</div>}
      </div>
    </div></div>
    <div id="preview-transcript" className="sr-only">{transcript}</div>
    <div className="preview-status"><span className={draft ? 'draft-dot' : 'saved-dot'} /><strong>{draft ? 'Unsaved preview' : 'Design preview'}</strong></div>
    <p className="preview-note">Browser-only design preview.{sample ? ' 示例任务与 AI 建议用于查看排版效果。' : ' 当前任务与编辑草稿实时显示。'}</p>
    <div className="display-colors" aria-label="Four display colors"><span><i className="color-black" />Black</span><span><i className="color-white" />White</span><span><i className="color-yellow" />Yellow</span><span><i className="color-red" />Red</span></div>
    <a className="connection-link" href="/connect">Device connection <span aria-hidden="true">↗</span></a>
  </section>;
}
