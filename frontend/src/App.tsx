import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../contracts/daily-overview';
import { createConfiguredSource, type DemoScenario, type OverviewSource } from './data/overview-source';
import { useOverview } from './data/use-overview';
import { CheckpointWorkspace } from './CheckpointWorkspace';
import { RecorderButton, RecorderFeedback, RecorderStatusLine, useForegroundRecorder } from './ForegroundRecord';
import DailyReview from './DailyReview';
import TaskCalendar, { validDay } from './TaskCalendar';
import DailySynthesis from './DailySynthesis';
import ActivityTimeline, { formatActivityDuration } from './ActivityTimeline';
import NextTask, { nextAction } from './NextTask';
import { useFocusReview } from './data/use-focus-review';
import ProjectProgress, { updateProject, type ProgressResponse } from './ProjectProgress';
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

const symbols = {
  today: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-14 5 2 2 4-4" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M7 3v4m10-4v4M7 14h2m3 0h2m-7 3h2"/></>,
  review: <><path d="M4 19V5m0 14h16M8 15v-3m5 3V7m5 8v-5" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>,
  screen: <><rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M12 17v3m-4 0h8" /></>,
  connect: <><path d="m8 9 7 7m-6-6-2 2a4 4 0 0 0 5.7 5.7l2-2M6 18l-3 3m8-10 3-3m0 6 3-3" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  refresh: <><path d="M19 9a7.4 7.4 0 1 0 .1 6M19 4v5h-5" /></>,
};
function DeskIcon({ name }: { name: keyof typeof symbols }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{symbols[name]}</svg>;
}

type View = 'today' | 'calendar' | 'review';

function linkedCalendarDate() {
  const day = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('date');
  return day && validDay(day) ? day : '';
}

function linkedView(): View {
  if (window.location.hash.split('?')[0] === '#calendar') return 'calendar';
  return window.location.hash === '#review' ? 'review' : 'today';
}

export default function App({ source = defaultSource }: { source?: OverviewSource }) {
  const [view, setView] = useState<View>(() => source.localWorkspace ? linkedView() : 'today');
  const [navOpen, setNavOpen] = useState(false);
  const navButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const [calendarDate, setCalendarDate] = useState(linkedCalendarDate);
  const [calendarOpened, setCalendarOpened] = useState(view === 'calendar');
  const [reviewOpened, setReviewOpened] = useState(view === 'review');
  const [checkpointVersion, setCheckpointVersion] = useState(0);
  const checkpointsChanged = useCallback(() => setCheckpointVersion(value => value + 1), []);
  const recorder = useForegroundRecorder(!!source.localWorkspace, checkpointsChanged);
  const recording = recorder.status?.state === 'recording' && !recorder.readError;
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const pinned = progress?.statuses.find(status => status.taskId === progress.config.pinned);
  async function saveAccomplishment(taskId: string, action: 'add-accomplishment' | 'remove-accomplishment', text: string) {
    if (!progress) throw new Error('正在读取任务记录，请稍后重试。');
    try {
      setProgress(await updateProject({ revision:progress.config.revision, taskId, action, text }));
    } finally {
      checkpointsChanged();
    }
  }
  async function restoreOverview() {
    if (!pinned || !progress) return;
    try {
      setProgress(await updateProject({action:'unpin', taskId:pinned.taskId, revision:progress.config.revision}));
    } finally {
      checkpointsChanged();
    }
  }
  const [scenario, setScenario] = useState<DemoScenario>('today');
  const [taskDraft, setTaskDraft] = useState<Task[] | null>(null);
  const [suggestionDraft, setSuggestionDraft] = useState<string | null>(null);
  const { overview, loading, error, lastRead, saving, reload, saveTasks, saveFocus, saveAISuggestion } = useOverview(source, scenario);
  const [chosenTask, chooseTask] = useState('');
  const tasks = overview?.tasks ?? [];
  const manual = tasks.find(task => task.id === chosenTask);
  const session = recorder.status;
  const observed = session?.observedAt ? tasks.find(task => task.id === session.observedTaskId) : undefined;
  const showRecorderDetails = session?.state !== 'idle' || !!session.observedAt || !!session.savedCount ||
    !!session.message || !!recorder.readError || !!recorder.actionError;
  const target = recording ? tasks.find(task => task.id === session?.targetTaskId) : undefined;
  const completed = overview?.tasks.filter(task => task.status === 'done').length ?? 0;
  const count = overview?.tasks.length ?? 0;
  const mock = source.kind === 'mock';
  const local = !mock && Boolean(source.updateTasks);
  const reviewKey = (overview?.revision ?? '') + ':' + checkpointVersion;
  const activity = useFocusReview({ active: !!overview && !!source.localWorkspace && view === 'today', focus:overview?.focus, refreshKey: reviewKey });
  const activityDate = activity.review?.date ?? overview?.date;
  const next = useMemo(() => overview && source.localWorkspace ? nextAction(overview, activity.review) : null,
    [overview, source.localWorkspace, activity.review]);
  const [revealApp, setRevealApp] = useState<{ name: string; request: number; date: string } | null>(null);
  const suggested = !session?.observedAt ? tasks.find(task => task.id === overview?.focus?.task_id) ??
    next?.task ?? tasks.find(task => task.status === 'todo') ?? tasks[0] : undefined;
  const selected = manual ?? observed ?? target ?? suggested;
  function inspectApp(name: string) {
    const date = activity.review?.date;
    if (date) setRevealApp(previous => ({ name, date, request: (previous?.request ?? 0) + 1 }));
  }
  function inspectHistory() {
    const history = document.querySelector<HTMLDetailsElement>('details#record');
    if (history) { history.open = true; history.querySelector('summary')?.focus(); }
  }
  function inspectTask(taskId: string) {
    chooseTask(taskId);
    requestAnimationFrame(() => document.getElementById('project-progress')?.focus());
  }
  async function startRecommended(task: Task) {
    if (!overview) return;
    await saveFocus({ action: 'start', revision: overview.revision, task_id: task.id });
    chooseTask(task.id);
  }
  const showView = useCallback((next: View) => {
    setNavOpen(false);
    if (next === 'review') setReviewOpened(true);
    if (next === 'calendar') setCalendarOpened(true);
    setView(next);
  }, []);
  useEffect(() => {
    if (!source.localWorkspace) return;
    const followLink = () => {
      const hash = window.location.hash;
      if (hash.split('?')[0] === '#calendar') { setCalendarDate(linkedCalendarDate()); showView('calendar'); }
      else if (!hash || hash === '#workspace' || hash === '#record' || hash === '#review') showView(linkedView());
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
  useEffect(() => {
    if (!navOpen) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !header.current?.contains(event.target)) setNavOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        navButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [navOpen]);
  function navigate(next: View) {
    showView(next);
    const hash = next === 'today' ? '' : next === 'calendar' && calendarDate ? '#calendar?date=' + calendarDate : '#' + next;
    if (window.location.hash !== hash) window.history.pushState(window.history.state, '', window.location.pathname + window.location.search + hash);
    document.getElementById('workspace')?.focus({ preventScroll: true });
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }

  function chooseCalendarDay(day: string) {
    setCalendarDate(day);
    if (window.location.hash.split('?')[0] !== '#calendar') return;
    const hash = '#calendar' + (day ? '?date=' + day : '');
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + hash);
  }

  const previewOverview = useMemo(() => {
    if (!overview) return null;
    const tasks = taskDraft ?? overview.tasks;
    const focus = tasks.some(task => task.id === overview.focus?.task_id && task.status === 'todo') ? overview.focus : null;
    return { ...overview, tasks, focus, ...(suggestionDraft === null ? {} : { ai_suggestion: suggestionDraft }) };
  }, [overview, taskDraft, suggestionDraft]);

  const focusPanel = overview && <FocusPanel overview={overview} saving={saving} preferredTaskId={selected?.status === 'todo' ? selected.id : next?.task?.id} onTaskSelect={chooseTask} onSave={source.updateFocus ? saveFocus : undefined} />;
  return <div className="dashboard">
    <a className="desk-skip" href="#workspace">跳至工作台</a>
    <header className="desk-header" ref={header} data-open={navOpen}>
      <div className="desk-header-inner">
        <a className="desk-brand" href="#workspace" aria-label="FocusDesk 首页"
          onClick={event => { event.preventDefault(); navigate('today'); }}>
          <span aria-hidden="true" className="desk-brand-mark"><i /><i /><i /></span>FocusDesk
        </a>
        <button type="button" className="desk-menu" ref={navButton} aria-expanded={navOpen}
          aria-controls="desk-navigation" aria-label={navOpen ? '收起导航' : '展开导航'} onClick={() => setNavOpen(open => !open)}>
          <DeskIcon name={navOpen ? 'close' : 'menu'} />
        </button>
        <nav id="desk-navigation" className="desk-nav" aria-label="主导航">
          <a href="#workspace" aria-current={view === 'today' ? 'page' : undefined}
            onClick={event => { event.preventDefault(); navigate('today'); }}><DeskIcon name="today" />工作台</a>
          {source.localWorkspace && <a href="#calendar" aria-current={view === 'calendar' ? 'page' : undefined}
            onClick={event => { event.preventDefault(); navigate('calendar'); }}><DeskIcon name="calendar" />任务日历</a>}
          {source.localWorkspace && <a href="#review" aria-current={view === 'review' ? 'page' : undefined}
            onClick={event => { event.preventDefault(); navigate('review'); }}><DeskIcon name="review" />每日回顾</a>}
          {local && <a href={import.meta.env.VITE_MAIL_PAGE_URL} target="_blank" rel="noreferrer" onClick={() => setNavOpen(false)}>
            <DeskIcon name="mail" />邮件与待办 <span className="desk-external" aria-hidden="true">↗</span></a>}
          <div className="desk-nav-divider" aria-hidden="true" />
          <a href="/simulator" target="_blank" rel="noreferrer" onClick={() => setNavOpen(false)}>
            <DeskIcon name="screen" />模拟屏 <span className="desk-external" aria-hidden="true">↗</span></a>
          <a href="/connect"><DeskIcon name="connect" />连接设备</a>
        </nav>
        <span className="desk-source" data-recording={recording}><i aria-hidden="true" />{recording ? (session?.mode === 'ai' ? 'AI 状态记录中' : '屏幕记录中') : mock ? '本地演示' : local ? '本机 Hub' : '只读 Hub'}</span>
      </div>
    </header>

    <main id="workspace" className="desk-main" tabIndex={-1}>
      {view === 'today' && <div className="desk-masthead">
        <div>
          <h1>今日工作台</h1>
          {activityDate && <p className="desk-date"><time dateTime={activityDate}>{dateFormat.format(new Date(activityDate + 'T12:00:00Z'))}</time></p>}
        </div>
        {activity.review && <dl className="today-totals">
          <div><dt>专注计时</dt><dd>{formatActivityDuration(activity.review.totalSeconds)}</dd></div>
          <div><dt>已记录前台</dt><dd>{formatActivityDuration((activity.review.appSessions ?? []).reduce((sum, item) => sum + item.seconds, 0))}</dd></div>
        </dl>}
        <button type="button" className="desk-reload" disabled={loading || saving} onClick={() => { reload(); activity.refresh(); }} title="重新读取" aria-label="重新读取">
          <DeskIcon name="refresh" />
        </button>
      </div>}
      <div className="status-region" aria-live="polite">
        {error && <div className="error-banner" role="alert">
          <div><strong>读取失败{overview ? ' · 正在显示上次成功内容' : ' · 暂无可显示内容'}</strong><p>{error}</p></div>
          <button className="secondary-button" onClick={reload} disabled={loading || saving}>重试</button>
        </div>}
        {loading && <p className={overview ? 'sr-only' : 'loading-line'} role="status">{overview ? '正在读取，暂时保留上次内容…' : '正在读取今日概览…'}</p>}
      </div>
      <div hidden={view !== 'today'}>
      {source.localWorkspace && overview && <div className="today-insights">
        <ActivityTimeline recorder={recorder} review={activity.review} tasks={tasks} revealApp={revealApp?.date === activity.review?.date ? revealApp : null} error={activity.error} onRetry={activity.refresh}/>
        <div className="today-brief">
          <NextTask overview={overview} next={next} saving={saving} onStart={source.updateFocus ? startRecommended : undefined} onInspect={task => inspectTask(task.id)} onApp={inspectApp} onHistory={inspectHistory}/>
          {activity.review && (activity.review.observations.length > 0 || activity.review.sessions.length > 0 || !!activity.review.appSessions?.length || !!activity.review.aiSessions?.length || !!activity.review.workActivities?.length) &&
            <DailySynthesis active={view === 'today'} review={activity.review}/>}
        </div>
      </div>}
      <div className="desk-grid">
        <div className="desk-work">
          <section className="desk-task-panel" aria-labelledby="overview-title" aria-busy={loading}>
            <div className="desk-section-head">
              <h2 id="overview-title">今日任务</h2>
              {overview && <div className="desk-completion" role="meter" aria-label={`${completed} 项已完成，共 ${count} 项`}
                aria-valuemin={0} aria-valuemax={Math.max(1, count)} aria-valuenow={completed}
                aria-valuetext={`${completed} 项已完成，共 ${count} 项`}>
                <span aria-hidden="true">{completed} / {count} 已完成</span>
              </div>}
              {source.localWorkspace && <RecorderButton recorder={recorder} />}
            </div>
            {overview && <TaskEditor overview={overview} saving={saving} onSave={source.updateTasks ? saveTasks : undefined}
              onDraftChange={setTaskDraft} active={view === 'today' && !navOpen}
              selectedId={selected?.id} observedId={observed?.id} manual={!!manual} statuses={source.localWorkspace ? progress?.statuses : undefined}
              onAccomplishment={source.localWorkspace ? saveAccomplishment : undefined}
              onSelect={source.localWorkspace ? inspectTask : source.updateFocus ? chooseTask : undefined} />}
            {source.localWorkspace && showRecorderDetails && <div className="task-recorder-state">
              <RecorderStatusLine recorder={recorder} timezone={overview?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} />
              <RecorderFeedback recorder={recorder} />
              {(session?.observedAt || (recording && session?.mode !== 'ai')) && <p className="project-recognition" aria-live="polite">{session?.observedAt ?
                observed ? <>最近识别的任务　<strong>{observed.title}</strong></> : <strong>最近画面未匹配任务</strong> :
                '等待识别当前画面…'}</p>}
            </div>}
            {source.localWorkspace && <>
              <ProjectProgress overview={overview} selected={selected} manual={!!manual} onFollow={() => chooseTask('')}
                recorder={recorder} refreshKey={checkpointVersion} data={progress} onData={setProgress} onChange={checkpointsChanged} />
              <CheckpointWorkspace overview={overview} recorder={recorder} active={view === 'today'} refreshKey={checkpointVersion} onChange={checkpointsChanged} />
            </>}
            {!mock && !source.updateTasks && <p className="readonly-note">请在本机打开 FocusDesk 编辑任务。</p>}
          </section>
          {overview && <AISuggestionEditor overview={overview} saving={saving} writable={Boolean(source.updateAISuggestion)}
            onSave={saveAISuggestion} onDraftChange={setSuggestionDraft} onReload={reload} />}
        </div>
        <aside className="desk-side" aria-label="专注与设备">
          {focusPanel}
          <EpaperPreview overview={previewOverview} project={pinned} onUnpin={restoreOverview} draft={taskDraft !== null || suggestionDraft !== null} />
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
      {source.localWorkspace && calendarOpened && <div hidden={view !== 'calendar'}>
        <TaskCalendar active={view === 'calendar'} date={calendarDate} onDate={chooseCalendarDay} onChange={reload}/>
      </div>}
      {source.localWorkspace && overview && reviewOpened && <div hidden={view !== 'review'}>
        <DailyReview focus={overview?.focus} refreshKey={reviewKey} active={view === 'review'} />
      </div>}
    </main>
  </div>;
}
