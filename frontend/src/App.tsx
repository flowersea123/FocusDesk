import { useMemo, useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import { createConfiguredSource, type DemoScenario, type OverviewSource } from './data/overview-source';
import { useOverview } from './data/use-overview';
import { CheckpointWorkspace } from './CheckpointWorkspace';
import DailyReview from './DailyReview';
import ProjectProgress from './ProjectProgress';
import type { ProjectStatus } from '../../contracts/project-progress';
import TaskEditor from './TaskEditor';
import FocusPanel from './FocusPanel';
import EpaperPreview from './EpaperPreview';
import AISuggestionEditor from './AISuggestionEditor';
import './dashboard.css';

const defaultSource = createConfiguredSource();
const scenarios: { value: DemoScenario; label: string }[] = [
  { value: 'today', label: '正常任务' }, { value: 'empty', label: '空列表' },
  { value: 'completed', label: '全部完成' }, { value: 'next-day', label: '次日样例' },
  { value: 'failure', label: '读取失败' },
];
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC',
});

function TaskList({ overview }: { overview: DailyOverview }) {
  if (!overview.tasks.length) return <p className="desk-empty">今天没有安排的任务</p>;
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: overview.timezone,
  });
  return <ul className="desk-tasks">{overview.tasks.map(task => {
    const done = task.status === 'done';
    const active = overview.focus?.task_id === task.id;
    return <li key={task.id} className={done ? 'task-done' : ''}>
      <span className="desk-task-mark" aria-hidden="true">{done && '✓'}</span>
      <span className="sr-only">{done ? '已完成，' : '待完成，'}</span>
      <span className="task-title">{task.title}</span>
      {active && <span className="desk-task-active">专注中</span>}
      {task.due_at && <time className="desk-due" dateTime={task.due_at}>{timeFormat.format(new Date(task.due_at))} 截止</time>}
    </li>;
  })}</ul>;
}

export default function App({ source = defaultSource }: { source?: OverviewSource }) {
  const [view, setView] = useState<'today' | 'screen' | 'review'>('today');
  const [reviewOpened, setReviewOpened] = useState(false);
  const [screenOpened, setScreenOpened] = useState(false);
  const [checkpointVersion, setCheckpointVersion] = useState(0);
  const [pinned, setPinned] = useState<ProjectStatus | null>(null);
  const [scenario, setScenario] = useState<DemoScenario>('today');
  const [taskDraft, setTaskDraft] = useState<Task[] | null>(null);
  const [suggestionDraft, setSuggestionDraft] = useState<string | null>(null);
  const { overview, loading, error, lastRead, saving, reload, saveTasks, saveFocus, saveAISuggestion } = useOverview(source, scenario);
  const completed = overview?.tasks.filter(task => task.status === 'done').length ?? 0;
  const count = overview?.tasks.length ?? 0;
  const mock = source.kind === 'mock';
  const local = !mock && Boolean(source.updateTasks);
  const previewOverview = useMemo(() => {
    if (!overview) return null;
    const tasks = taskDraft ?? overview.tasks;
    const focus = tasks.some(task => task.id === overview.focus?.task_id && task.status === 'todo') ? overview.focus : null;
    return { ...overview, tasks, focus, ...(suggestionDraft === null ? {} : { ai_suggestion: suggestionDraft }) };
  }, [overview, taskDraft, suggestionDraft]);

  return <div className="dashboard">
    <a className="desk-skip" href="#workspace">跳至工作台</a>
    <header className="desk-header"><div className="desk-header-inner">
      <a className="desk-brand" href="./" aria-label="FocusDesk 首页">
        <span aria-hidden="true" className="desk-brand-mark"><i /><i /><i /></span>FocusDesk
      </a>
      <nav className="desk-nav" aria-label="主导航">
        <a href="#workspace" aria-current="page">工作台</a>
        {local && <a href={import.meta.env.VITE_MAIL_PAGE_URL} target="_blank" rel="noreferrer">邮件与待办 <span aria-hidden="true">↗</span></a>}
        <a href="/simulator" target="_blank" rel="noreferrer">模拟屏 <span aria-hidden="true">↗</span></a>
        <a href="/connect">连接设备</a>
      </nav>
      <span className="desk-source"><i aria-hidden="true" />{mock ? '本地演示' : local ? '本机 Hub' : '只读 Hub'}</span>
    </div></header>

    <main id="workspace" className="desk-main" tabIndex={-1}>
      <div className="desk-masthead">
        <div>
          <h1>今日工作台</h1>
          {overview && <p className="desk-date">
            <time dateTime={overview.date}>{dateFormat.format(new Date(overview.date + 'T12:00:00Z'))}</time>
            <span>{overview.timezone}</span>
          </p>}
        </div>
        <button type="button" className="desk-reload" disabled={loading || saving} onClick={reload}>
          <span aria-hidden="true">↻</span> 重新读取
        </button>
      </div>
      <div className="status-region" aria-live="polite">
        {error && <div className="error-banner" role="alert">
          <div><strong>读取失败{overview ? ' · 正在显示上次成功内容' : ' · 暂无可显示内容'}</strong><p>{error}</p></div>
          <button className="secondary-button" onClick={reload} disabled={loading || saving}>重试</button>
        </div>}
        {loading && <p className={overview ? 'sr-only' : 'loading-line'} role="status">{overview ? '正在读取，暂时保留上次内容…' : '正在读取今日概览…'}</p>}
      </div>
      {source.localWorkspace && overview && <div className="workspace-views" role="group" aria-label="工作台视图">
        <button type="button" aria-pressed={view === 'today'} onClick={() => setView('today')}>今天任务</button>
        <button type="button" aria-pressed={view === 'screen'} onClick={() => { setScreenOpened(true); setView('screen'); }} aria-label="屏幕记录">屏幕记录<span className="workspace-capture-indicator"> · 周期采样</span></button>
        <button type="button" aria-pressed={view === 'review'} onClick={() => { setReviewOpened(true); setView('review'); }}>每日回顾</button>
      </div>}
      <div hidden={view !== 'today'}>
      <div className="desk-grid">
        <div className="desk-work">
          {overview && <FocusPanel overview={overview} saving={saving} onSave={source.updateFocus ? saveFocus : undefined} />}
          {source.localWorkspace && overview && <ProjectProgress overview={overview} refreshKey={checkpointVersion} onPinned={setPinned} />}
          <section className="desk-task-panel" aria-labelledby="overview-title" aria-busy={loading}>
            <div className="desk-section-head">
              <h2 id="overview-title">今日任务</h2>
              {overview && <div className="desk-completion" role="meter" aria-label={`${completed} 项已完成，共 ${count} 项`}
                aria-valuemin={0} aria-valuemax={Math.max(1, count)} aria-valuenow={completed}
                aria-valuetext={`${completed} 项已完成，共 ${count} 项`}>
                <span aria-hidden="true">{completed} / {count} 已完成</span>
                <span className="desk-progress" aria-hidden="true"><i style={{ width: `${count ? completed / count * 100 : 0}%` }} /></span>
              </div>}
            </div>
            {overview && <TaskList overview={overview} />}
            {overview && source.updateTasks && <TaskEditor overview={overview} saving={saving} onSave={saveTasks} onDraftChange={setTaskDraft} />}
            {!mock && !source.updateTasks && <p className="readonly-note">请在本机打开 FocusDesk 编辑任务。</p>}
          </section>
          {overview && <AISuggestionEditor overview={overview} saving={saving} writable={Boolean(source.updateAISuggestion)}
            onSave={saveAISuggestion} onDraftChange={setSuggestionDraft} />}
        </div>
        <aside className="desk-side" aria-label="设备">
          <EpaperPreview overview={previewOverview} project={pinned} draft={taskDraft !== null || suggestionDraft !== null} />
        </aside>
      </div>
      <details className="desk-details" open={mock}>
        <summary>数据来源与版本</summary>
        <div className="desk-metadata">
          <div><span>{error ? '上次成功版本' : '数据版本'}</span><code>{overview?.revision ?? '等待读取'}</code></div>
          <div><span>最近读取</span>{lastRead ? lastRead.toLocaleTimeString('zh-CN', { hour12: false }) : '尚无记录'}</div>
        </div>
        <p>{mock ? '合成任务使用固定演示日期。' : '工作台日期取自任务文件。'}{overview && ` ${overview.date} · ${overview.timezone}`}</p>
        {mock && <div className="scenario-options" role="group" aria-label="切换演示样例">{scenarios.map(item =>
          <button type="button" key={item.value} onClick={() => setScenario(item.value)} aria-pressed={scenario === item.value}>{item.label}</button>)}</div>}
      </details>
      </div>
      {source.localWorkspace && overview && screenOpened && <div hidden={view !== 'screen'}><CheckpointWorkspace overview={overview} active={view === 'screen'} onChange={() => setCheckpointVersion(v => v + 1)} /></div>}
      {source.localWorkspace && overview && reviewOpened && <div hidden={view !== 'review'}>
        <DailyReview refreshKey={overview.revision + ':' + checkpointVersion} />
      </div>}
    </main>
  </div>;
}
