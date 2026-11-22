import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import { deviceTaskLabel } from '../../contracts/device-task-label';
import type { ProjectStatus } from '../../contracts/project-progress';
import { buildProjectDisplay, type DisplaySnapshot } from '../../contracts/display-snapshot';
import { paintDisplaySnapshot } from './simulator/canvas';
import './epaper-preview.css';

const overviewDate = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function ProjectCanvas({ snapshot }: { snapshot: DisplaySnapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current) paintDisplaySnapshot(canvas.current, snapshot);
  }, [snapshot]);
  return <canvas ref={canvas} width={400} height={300} aria-hidden="true" className="project-device-canvas"/>;
}

const sampleTasks: Task[] = [
  'Finish project proposal', 'Review presentation', 'Read 10 pages',
  'Prepare tomorrow’s outline', 'Organize research notes', 'Reply to project feedback',
].map((title, index) => ({ id: `preview-${index}`, title, status: 'todo', due_at: null }));

export default function EpaperPreview({ overview, draft, project, onUnpin }: { overview: DailyOverview | null; draft: boolean; project?: ProjectStatus | null; onUnpin?: () => Promise<void> }) {
  const [sample, setSample] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  async function unpin() {
    if (restoring || !onUnpin) return;
    setRestoring(true); setError('');
    try { await onUnpin(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '恢复总览失败，请重试。'); }
    finally { setRestoring(false); }
  }
  const tasks = sample ? sampleTasks : overview?.tasks ?? [];
  const pending = tasks.filter(task => task.status === 'todo');
  const focus = sample ? null : overview?.focus;
  const priority = pending.find(task => task.id === focus?.task_id) ?? pending[0];
  const ordered = priority ? [priority, ...pending.filter(task => task.id !== priority.id)] : [];
  const visible = ordered.slice(0, 5).map(task => ({ ...task, title:deviceTaskLabel(task) }));
  const hidden = Math.max(0, ordered.length - visible.length);
  const date = overview?.date ?? '2026-11-12';
  const dateLabel = overviewDate
    .format(new Date(`${date}T12:00:00Z`)).toUpperCase();
  const progress = `${tasks.filter(task => task.status === 'done').length} / ${tasks.length} DONE`;
  const focusTime = useMemo(() => new Intl.DateTimeFormat('en-GB', {hour:'2-digit', minute:'2-digit', hourCycle:'h23', timeZone:overview?.timezone}), [overview?.timezone]);
  const focusLabel = focus && priority?.id === focus.task_id
    ? `FOCUS - UNTIL ${focusTime.format(new Date(focus.ends_at))}`
    : '';
  const emptyLabel = tasks.length ? 'All tasks done' : 'No tasks for today';
  const recommendation = (overview?.ai_suggestion ?? (sample ? 'Draft the outline, then focus for 25 min.' : '')).trim() || 'No suggestion yet.';
  const available = Boolean(overview || sample);
  const pinned = !sample && project;
  const snapshot = useMemo(() => pinned ? buildProjectDisplay(pinned, 'preview') : null, [pinned]);
  const transcript = snapshot ? snapshot.commands.flatMap(command => command[0] === 1 ? [command[5]] : []).join(' ') : available ? ['FOCUSDESK', dateLabel, 'Tasks', progress, focusLabel,
    ...visible.map(task => task.title), !visible.length && emptyLabel, hidden && `+${hidden} more`,
    'AI RECOMMENDATION', recommendation].filter(Boolean).join(' ') : '';
  return <section className="preview-card" aria-labelledby="preview-title">
    <div className="section-heading"><h2 id="preview-title" lang="en">E-Paper Preview</h2><span className="dimension-label">400 × 300</span></div>
    <div className="preview-source-options" role="group" aria-label="预览内容">
      <button type="button" aria-pressed={!sample} onClick={() => setSample(false)}>当前任务</button>
      <button type="button" aria-pressed={sample} onClick={() => setSample(true)}>多任务示例</button>
    </div>
    <a className="device-stage" href="/simulator" target="_blank" rel="noreferrer"
      aria-label="打开模拟屏查看设备已保存的画面（新标签页）" title="打开设备模拟屏">
      <div className="device-frame">
      <div className="paper-design" role="img" aria-label="400 × 300 e-paper preview" aria-describedby="preview-transcript"
        data-width="400" data-height="300" data-source-revision={overview?.revision ?? ''} data-preview-mode={sample ? 'sample' : 'workspace'}>
        {snapshot ? <ProjectCanvas snapshot={snapshot} /> : available ? <div className="paper-layout" aria-hidden="true">
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
      </div>
    </a>
    <div id="preview-transcript" className="sr-only">{transcript}</div>
    <div className="preview-status"><span className={draft ? 'draft-dot' : 'saved-dot'} /><strong>{pinned ? '电子屏已固定「' + pinned.title + '」' : draft ? '未保存草稿' : sample ? '示例预览' : '当前任务预览'}</strong></div>
    {project && onUnpin && <div className="preview-pin-actions">
      {sample && <span>电子屏已固定「{project.title}」</span>}
      <button type="button" disabled={restoring} onClick={() => void unpin()}>{restoring ? '正在恢复…' : '恢复电子屏总览'}</button>
    </div>}
    {error && project && <p role="alert">{error}</p>}
    <p className="preview-note">{pinned ? '模拟屏与设备读取同一份任务进度。' : sample ? '合成任务仅用于查看排版。' : '浏览器内随编辑更新，设备下次读取时使用已保存的内容。'}</p>
    <div className="display-colors" aria-label="电子纸四色"><span><i className="color-black" />黑</span><span><i className="color-white" />白</span><span><i className="color-yellow" />黄</span><span><i className="color-red" />红</span></div>
    <a className="connection-link" href="/connect"><span lang="en">Devices</span> <span aria-hidden="true">↗</span></a>
  </section>;
}
