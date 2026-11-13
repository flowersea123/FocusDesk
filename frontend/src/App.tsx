import { useMemo, useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import { createConfiguredSource, type DemoScenario, type OverviewSource } from './data/overview-source';
import { useOverview } from './data/use-overview';
import TaskEditor from './TaskEditor';
import FocusPanel from './FocusPanel';
import EpaperPreview from './EpaperPreview';
import AISuggestionEditor from './AISuggestionEditor';

const defaultSource = createConfiguredSource();
const scenarios: { value: DemoScenario; label: string }[] = [
  { value: 'today', label: '正常任务' }, { value: 'empty', label: '空列表' },
  { value: 'completed', label: '全部完成' }, { value: 'next-day', label: '次日样例' },
  { value: 'failure', label: '读取失败' },
];

function TaskList({ overview }: { overview: DailyOverview }) {
  if (!overview.tasks.length) return <div className="empty-state"><p>今天没有安排的任务</p></div>;
  return <ul className="task-list">{overview.tasks.map(task => <li key={task.id} className={task.status === 'done' ? 'is-done' : ''}>
    <span className="task-check" aria-label={task.status === 'done' ? '已完成' : '未完成'}>{task.status === 'done' ? '✓' : ''}</span>
    <div className="task-copy"><span className="task-title">{task.title}</span><span className="task-detail">{task.status === 'done' ? '已完成' : '待完成'}{task.due_at ? ` · ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: overview.timezone }).format(new Date(task.due_at))} 截止` : ''}</span></div>
  </li>)}</ul>;
}

export default function App({ source = defaultSource }: { source?: OverviewSource }) {
  const [scenario, setScenario] = useState<DemoScenario>('today');
  const [taskDraft, setTaskDraft] = useState<Task[] | null>(null);
  const [suggestionDraft, setSuggestionDraft] = useState<string | null>(null);
  const { overview, loading, error, lastRead, saving, reload, saveTasks, saveFocus, saveAISuggestion } = useOverview(source, scenario);
  const completed = overview?.tasks.filter(task => task.status === 'done').length ?? 0;
  const count = overview?.tasks.length ?? 0;
  const mock = source.kind === 'mock';
  const previewOverview = useMemo(() => {
    if (!overview) return null;
    const tasks = taskDraft ?? overview.tasks;
    const focus = overview.focus && tasks.some(task => task.id === overview.focus!.task_id && task.status === 'todo') ? overview.focus : null;
    return { ...overview, tasks, focus, ...(suggestionDraft === null ? {} : { ai_suggestion: suggestionDraft }) };
  }, [overview, taskDraft, suggestionDraft]);
  const dateLabel = overview ? new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${overview.date}T12:00:00Z`)) : 'Waiting for your work state';

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="./" aria-label="FocusDesk home">FocusDesk</a>
      <nav aria-label="Main navigation"><a className="nav-current" href="#workspace">Daily overview</a><a href="/connect">Device connection <span aria-hidden="true">↗</span></a></nav>
      <span className="source-badge">{mock ? '本地 Mock 演示' : 'Local Hub'}</span></header>
    <main id="workspace">
      <div className="page-heading"><h1>Daily overview</h1><p className="workspace-date">{dateLabel}<span>{overview?.timezone ?? 'Local-first workspace'}</span></p></div>
      <div className="status-region" aria-live="polite">
        {error && <div className="error-banner" role="alert"><div><strong>读取失败{overview ? ' · 正在显示上次成功内容' : ' · 暂无可显示内容'}</strong><p>{error}</p></div><button className="secondary-button" onClick={reload} disabled={loading || saving}>重试</button></div>}
        {loading && <p className="loading-line" role="status">{overview ? '正在读取，暂时保留上次内容…' : '正在读取今日概览…'}</p>}
      </div>
      <div className="workspace-grid"><div className="management-column">
        <section className="overview-card" aria-labelledby="overview-title" aria-busy={loading}>
          <div className="section-heading"><div><p className="eyebrow">TO-DO LIST</p><h2 id="overview-title">今日任务</h2></div><span className="task-count">{completed} / {count} completed</span></div>
          <div className="progress-track" aria-label={overview ? `${completed} 项已完成，共 ${count} 项` : '等待任务数据'}><span style={{ width: `${count ? completed / count * 100 : 0}%` }} /></div>
          {overview && <TaskList overview={overview} />}
          {overview && source.updateTasks && <TaskEditor overview={overview} saving={saving} onSave={saveTasks} onDraftChange={setTaskDraft} />}
          {!mock && !source.updateTasks && <p className="readonly-note">请在本机打开 FocusDesk 编辑任务；当前来源仅供读取。</p>}
          {overview && source.updateFocus && <FocusPanel overview={overview} saving={saving} onSave={saveFocus} />}
        </section>
        {overview && <AISuggestionEditor overview={overview} saving={saving} writable={Boolean(source.updateAISuggestion)}
          onSave={saveAISuggestion} onDraftChange={setSuggestionDraft} />}
      </div><aside className="preview-column"><EpaperPreview overview={previewOverview} draft={Boolean(taskDraft) || suggestionDraft !== null} /></aside></div>
      <details className="workspace-details" open={mock}><summary>Workspace details</summary>
        <div className="data-caption"><span>{error ? 'Last valid snapshot' : 'Saved revision'}<code>{overview?.revision ?? 'Not loaded'}</code></span><span>{lastRead ? `Last read ${lastRead.toLocaleTimeString('en-GB')}` : 'No successful read yet'}</span></div>
        <p>{mock ? '合成数据 · 固定演示日期，不是实时今日。' : '日期以任务文件为准，不是实时今日。'} {overview?.date} · {overview?.timezone}</p>
        {mock && <div className="scenario-options" role="group" aria-label="切换演示样例">{scenarios.map(item => <button type="button" key={item.value} onClick={() => setScenario(item.value)} aria-pressed={scenario === item.value}>{item.label}</button>)}</div>}
        <button type="button" className="secondary-button" disabled={loading || saving} onClick={reload}>重新读取</button>
      </details>
    </main>
    <footer><span>FocusDesk</span><span>ONE THING AT A TIME</span></footer>
  </div>;
}
