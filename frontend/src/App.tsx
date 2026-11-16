import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import { createConfiguredSource, type DemoScenario, type OverviewSource } from './data/overview-source';
import { useOverview } from './data/use-overview';
import { CheckpointWorkspace } from './CheckpointWorkspace';
import { RecorderButton, RecorderFeedback, RecorderStatusLine, useForegroundRecorder } from './ForegroundRecord';
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

function TaskList({ overview, selectedId, observedId, manual, onSelect }: {
  overview: DailyOverview; selectedId?: string; observedId?: string; manual?: boolean; onSelect?: (id: string) => void;
}) {
  if (!overview.tasks.length) return <p className="desk-empty">今天没有安排的任务</p>;
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: overview.timezone,
  });
  return <ul className="desk-tasks">{overview.tasks.map(task => {
    const done = task.status === 'done';
    const active = overview.focus?.task_id === task.id;
    const selected = !!onSelect && selectedId === task.id;
    return <li key={task.id} className={done ? 'task-done' : ''} data-selected={selected || undefined}>
      <span className="desk-task-mark" aria-hidden="true">{done && '✓'}</span>
      <span className="sr-only">{done ? '已完成，' : '待完成，'}</span>
      {onSelect ? <button type="button" className="task-title task-progress-select" aria-label={'查看 ' + task.title + ' 进度'}
        aria-controls="project-progress" aria-pressed={selected} onClick={() => onSelect(task.id)}>{task.title}</button> :
        <span className="task-title">{task.title}</span>}
      {observedId === task.id && <span className="task-recognized">截图识别</span>}
      {selected && manual && observedId !== task.id && <span className="desk-task-active">正在查看</span>}
      {active && <span className="desk-task-active">专注中</span>}
      {task.due_at && <time className="desk-due" dateTime={task.due_at}>{timeFormat.format(new Date(task.due_at))} 截止</time>}
    </li>;
  })}</ul>;
}

type View = 'today' | 'review';

function linkedView(): View {
  return window.location.hash === '#review' ? 'review' : 'today';
}

export default function App({ source = defaultSource }: { source?: OverviewSource }) {
  const [view, setView] = useState<View>(() => source.localWorkspace ? linkedView() : 'today');
  const [reviewOpened, setReviewOpened] = useState(view === 'review');
  const [checkpointVersion, setCheckpointVersion] = useState(0);
  const checkpointsChanged = useCallback(() => setCheckpointVersion(value => value + 1), []);
  const recorder = useForegroundRecorder(!!source.localWorkspace, checkpointsChanged);
  const recording = recorder.status?.state === 'recording' && !recorder.readError;
  const [pinned, setPinned] = useState<ProjectStatus | null>(null);
  const [scenario, setScenario] = useState<DemoScenario>('today');
  const [taskDraft, setTaskDraft] = useState<Task[] | null>(null);
  const [suggestionDraft, setSuggestionDraft] = useState<string | null>(null);
  const { overview, loading, error, lastRead, saving, reload, saveTasks, saveFocus, saveAISuggestion } = useOverview(source, scenario);
  const [chosenTask, chooseTask] = useState('');
  const tasks = overview?.tasks ?? [];
  const manual = tasks.find(task => task.id === chosenTask);
  const session = recorder.status;
  const observed = session?.observedAt ? tasks.find(task => task.id === session.observedTaskId) : undefined;
  const target = recording ? tasks.find(task => task.id === session?.targetTaskId) : undefined;
  const suggested = !session?.observedAt ? tasks.find(task => task.id === overview?.focus?.task_id) ?? tasks.find(task => task.status === 'todo') ?? tasks[0] : undefined;
  const selected = manual ?? observed ?? target ?? suggested;
  const completed = overview?.tasks.filter(task => task.status === 'done').length ?? 0;
  const count = overview?.tasks.length ?? 0;
  const mock = source.kind === 'mock';
  const local = !mock && Boolean(source.updateTasks);
  const showView = useCallback((next: View) => {
    if (next === 'review') setReviewOpened(true);
    setView(next);
  }, []);
  useEffect(() => {
    if (!source.localWorkspace) return;
    const followLink = () => {
      const hash = window.location.hash;
      if (!hash || hash === '#workspace' || hash === '#record' || hash === '#review') showView(linkedView());
      if (hash === '#record') {
        const details = document.getElementById('record') as HTMLDetailsElement | null;
        if (details) {
          details.open = true;
          requestAnimationFrame(() => details.querySelector('summary')?.focus());
        }
      }
    };
    followLink();
    window.addEventListener('hashchange', followLink);
    window.addEventListener('popstate', followLink);
    return () => {
      window.removeEventListener('hashchange', followLink);
      window.removeEventListener('popstate', followLink);
    };
  }, [source.localWorkspace, showView]);
  function navigate(next: View) {
    showView(next);
    const hash = next === 'review' ? '#review' : '';
    if (window.location.hash !== hash) window.history.pushState(window.history.state, '', window.location.pathname + window.location.search + hash);
  }

  const previewOverview = useMemo(() => {
    if (!overview) return null;
    const tasks = taskDraft ?? overview.tasks;
    const focus = tasks.some(task => task.id === overview.focus?.task_id && task.status === 'todo') ? overview.focus : null;
    return { ...overview, tasks, focus, ...(suggestionDraft === null ? {} : { ai_suggestion: suggestionDraft }) };
  }, [overview, taskDraft, suggestionDraft]);

  const focusPanel = overview && <FocusPanel overview={overview} saving={saving} onSave={source.updateFocus ? saveFocus : undefined} />;
  return <div className="dashboard">
    <a className="desk-skip" href="#workspace">跳至工作台</a>
    <header className="desk-header"><div className="desk-header-inner">
      <a className="desk-brand" href="./" aria-label="FocusDesk 首页">
        <span aria-hidden="true" className="desk-brand-mark"><i /><i /><i /></span>FocusDesk
      </a>
      <nav className="desk-nav" aria-label="主导航">
        <a href="#workspace" aria-current={view === 'today' ? 'page' : undefined} onClick={() => showView('today')}>工作台</a>
        {source.localWorkspace && <a href="#review" aria-current={view === 'review' ? 'page' : undefined}
          onClick={event => { event.preventDefault(); navigate('review'); }}>每日回顾</a>}
        {local && <a href={import.meta.env.VITE_MAIL_PAGE_URL} target="_blank" rel="noreferrer">邮件与待办 <span aria-hidden="true">↗</span></a>}
        <a href="/simulator" target="_blank" rel="noreferrer">模拟屏 <span aria-hidden="true">↗</span></a>
        <a href="/connect">连接设备</a>
      </nav>
      <span className="desk-source"><i aria-hidden="true" />{recording ? '屏幕记录中' : mock ? '本地演示' : local ? '本机 Hub' : '只读 Hub'}</span>
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
      <div hidden={view !== 'today'}>
      <div className="desk-grid">
        <div className="desk-work">
          {!source.localWorkspace && focusPanel}
          <section className="desk-task-panel" aria-labelledby="overview-title" aria-busy={loading}>
            <div className="desk-section-head">
              <h2 id="overview-title">今日任务</h2>
              {source.localWorkspace && <RecorderButton recorder={recorder} />}
              {overview && <div className="desk-completion" role="meter" aria-label={`${completed} 项已完成，共 ${count} 项`}
                aria-valuemin={0} aria-valuemax={Math.max(1, count)} aria-valuenow={completed}
                aria-valuetext={`${completed} 项已完成，共 ${count} 项`}>
                <span aria-hidden="true">{completed} / {count} 已完成</span>
                <span className="desk-progress" aria-hidden="true"><i style={{ width: `${count ? completed / count * 100 : 0}%` }} /></span>
              </div>}
            </div>
            {source.localWorkspace && <div className="task-recorder-state">
              <RecorderStatusLine recorder={recorder} timezone={overview?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} />
              <RecorderFeedback recorder={recorder} />
              <p className="project-recognition" aria-live="polite">{session?.observedAt ?
                observed ? <>最近识别的任务　<strong>{observed.title}</strong></> : <strong>最近画面未匹配任务</strong> :
                recording ? '等待识别当前画面…' : '开始记录后，截图会自动更新对应任务的进度。'}</p>
            </div>}
            {overview && <TaskList overview={overview} selectedId={selected?.id} observedId={observed?.id} manual={!!manual}
              onSelect={source.localWorkspace ? chooseTask : undefined} />}
            {source.localWorkspace && <>
              <ProjectProgress overview={overview} selected={selected} manual={!!manual} onFollow={() => chooseTask('')}
                recorder={recorder} refreshKey={checkpointVersion} onPinned={setPinned} onChange={checkpointsChanged} />
              <CheckpointWorkspace overview={overview} recorder={recorder} active={view === 'today'} refreshKey={checkpointVersion} onChange={checkpointsChanged} />
            </>}
            {overview && source.updateTasks && <TaskEditor overview={overview} saving={saving} onSave={saveTasks} onDraftChange={setTaskDraft} />}
            {!mock && !source.updateTasks && <p className="readonly-note">请在本机打开 FocusDesk 编辑任务。</p>}
          </section>
          {source.localWorkspace && focusPanel}
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
      {source.localWorkspace && overview && reviewOpened && <div hidden={view !== 'review'}>
        <DailyReview refreshKey={overview.revision + ':' + checkpointVersion} />
      </div>}
    </main>
  </div>;
}
