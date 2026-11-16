import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../contracts/daily-overview';
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

const symbols = {
  today: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-14 5 2 2 4-4" /></>,
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

type View = 'today' | 'review';

function linkedView(): View {
  return window.location.hash === '#review' ? 'review' : 'today';
}

export default function App({ source = defaultSource }: { source?: OverviewSource }) {
  const [view, setView] = useState<View>(() => source.localWorkspace ? linkedView() : 'today');
  const [navOpen, setNavOpen] = useState(false);
  const navButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
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
  const showRecorderDetails = session?.state !== 'idle' || !!session.observedAt || !!session.savedCount ||
    !!session.message || !!recorder.readError || !!recorder.actionError;
  const target = recording ? tasks.find(task => task.id === session?.targetTaskId) : undefined;
  const suggested = !session?.observedAt ? tasks.find(task => task.id === overview?.focus?.task_id) ?? tasks.find(task => task.status === 'todo') ?? tasks[0] : undefined;
  const selected = manual ?? observed ?? target ?? suggested;
  const completed = overview?.tasks.filter(task => task.status === 'done').length ?? 0;
  const count = overview?.tasks.length ?? 0;
  const mock = source.kind === 'mock';
  const local = !mock && Boolean(source.updateTasks);
  const showView = useCallback((next: View) => {
    setNavOpen(false);
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
    const hash = next === 'review' ? '#review' : '';
    if (window.location.hash !== hash) window.history.pushState(window.history.state, '', window.location.pathname + window.location.search + hash);
    document.getElementById('workspace')?.focus({ preventScroll: true });
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }

  const previewOverview = useMemo(() => {
    if (!overview) return null;
    const tasks = taskDraft ?? overview.tasks;
    const focus = tasks.some(task => task.id === overview.focus?.task_id && task.status === 'todo') ? overview.focus : null;
    return { ...overview, tasks, focus, ...(suggestionDraft === null ? {} : { ai_suggestion: suggestionDraft }) };
  }, [overview, taskDraft, suggestionDraft]);

  const focusPanel = overview && <FocusPanel overview={overview} saving={saving} preferredTaskId={selected?.id} onTaskSelect={chooseTask} onSave={source.updateFocus ? saveFocus : undefined} />;
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
          {source.localWorkspace && <a href="#review" aria-current={view === 'review' ? 'page' : undefined}
            onClick={event => { event.preventDefault(); navigate('review'); }}><DeskIcon name="review" />每日回顾</a>}
          {local && <a href={import.meta.env.VITE_MAIL_PAGE_URL} target="_blank" rel="noreferrer" onClick={() => setNavOpen(false)}>
            <DeskIcon name="mail" />邮件与待办 <span className="desk-external" aria-hidden="true">↗</span></a>}
          <div className="desk-nav-divider" aria-hidden="true" />
          <a href="/simulator" target="_blank" rel="noreferrer" onClick={() => setNavOpen(false)}>
            <DeskIcon name="screen" />模拟屏 <span className="desk-external" aria-hidden="true">↗</span></a>
          <a href="/connect"><DeskIcon name="connect" />连接设备</a>
        </nav>
        <span className="desk-source" data-recording={recording}><i aria-hidden="true" />{recording ? '屏幕记录中' : mock ? '本地演示' : local ? '本机 Hub' : '只读 Hub'}</span>
      </div>
    </header>

    <main id="workspace" className="desk-main" tabIndex={-1}>
      {view === 'today' && <div className="desk-masthead">
        <div>
          <h1>今日工作台</h1>
          {overview && <p className="desk-date"><time dateTime={overview.date}>{dateFormat.format(new Date(overview.date + 'T12:00:00Z'))}</time></p>}
        </div>
        <button type="button" className="desk-reload" disabled={loading || saving} onClick={reload} title="重新读取" aria-label="重新读取">
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
      <div className="desk-grid">
        <div className="desk-work">
          <section className="desk-task-panel" aria-labelledby="overview-title" aria-busy={loading}>
            <div className="desk-section-head">
              <h2 id="overview-title">今日任务</h2>
              {overview && <div className="desk-completion" role="meter" aria-label={`${completed} 项已完成，共 ${count} 项`}
                aria-valuemin={0} aria-valuemax={Math.max(1, count)} aria-valuenow={completed}
                aria-valuetext={`${completed} 项已完成，共 ${count} 项`}>
                <span aria-hidden="true">{completed} / {count} 已完成</span>
                <span className="desk-progress" aria-hidden="true"><i style={{ width: `${count ? completed / count * 100 : 0}%` }} /></span>
              </div>}
              {source.localWorkspace && <RecorderButton recorder={recorder} />}
            </div>
            {overview && <TaskEditor overview={overview} saving={saving} onSave={source.updateTasks ? saveTasks : undefined}
              onDraftChange={setTaskDraft} active={view === 'today' && !navOpen}
              selectedId={selected?.id} observedId={observed?.id} manual={!!manual}
              onSelect={source.localWorkspace || source.updateFocus ? chooseTask : undefined} />}
            {source.localWorkspace && showRecorderDetails && <div className="task-recorder-state">
              <RecorderStatusLine recorder={recorder} timezone={overview?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} />
              <RecorderFeedback recorder={recorder} />
              {(session?.observedAt || recording) && <p className="project-recognition" aria-live="polite">{session?.observedAt ?
                observed ? <>最近识别的任务　<strong>{observed.title}</strong></> : <strong>最近画面未匹配任务</strong> :
                '等待识别当前画面…'}</p>}
            </div>}
            {source.localWorkspace && <>
              <ProjectProgress overview={overview} selected={selected} manual={!!manual} onFollow={() => chooseTask('')}
                recorder={recorder} refreshKey={checkpointVersion} onPinned={setPinned} onChange={checkpointsChanged} />
              <CheckpointWorkspace overview={overview} recorder={recorder} active={view === 'today'} refreshKey={checkpointVersion} onChange={checkpointsChanged} />
            </>}
            {!mock && !source.updateTasks && <p className="readonly-note">请在本机打开 FocusDesk 编辑任务。</p>}
          </section>
          {overview && <AISuggestionEditor overview={overview} saving={saving} writable={Boolean(source.updateAISuggestion)}
            onSave={saveAISuggestion} onDraftChange={setSuggestionDraft} onReload={reload} />}
        </div>
        <aside className="desk-side" aria-label="专注与设备">
          {focusPanel}
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
