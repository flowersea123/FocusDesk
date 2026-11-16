import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOverview } from '../../contracts/daily-overview';
import { checkpointSourceLabel, type ScreenCheckpoint, type CheckpointHistory } from '../../contracts/screen-checkpoint';
import type { RecorderControls } from './ForegroundRecord';
import ScreenObservation from './ScreenObservation';
import './checkpoint-workspace.css';

export async function checkpointRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '本机服务未能完成请求。');
  return result;
}
export function confirmReadingBookmark(id: string, section: string) {
  return checkpointRequest('/api/v1/checkpoints', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, readingSection: section }) });
}

type Props = {
  overview: DailyOverview | null;
  recorder: RecorderControls;
  active: boolean;
  refreshKey: number;
  onChange: () => void;
};

export function CheckpointWorkspace({ overview, recorder, active, refreshKey, onChange }: Props) {
  const [history, setHistory] = useState<CheckpointHistory | null>(null);
  const [limit, setLimit] = useState(12);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [removing, setRemoving] = useState('');
  const [working, setWorking] = useState(false);
  const pendingSave = useRef<{ key: string; id: string } | null>(null);
  const sequence = useRef(0);
  const tasks = overview?.tasks ?? [];
  const timezone = overview?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await checkpointRequest<CheckpointHistory>('/api/v1/checkpoints' + (limit > 12 ? '?limit=' + limit : ''));
      if (!Array.isArray(result.records)) throw new Error('本机服务返回的时间线无法读取。');
      if (request === sequence.current) { setHistory(result); setReadError(''); }
    } catch (err) {
      if (request === sequence.current) setReadError((err as Error).message);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [limit]);
  useEffect(() => { if (active) void load(); return () => { sequence.current++; }; }, [load, active, refreshKey]);

  async function save(record: Omit<ScreenCheckpoint, 'id'>, signal?: AbortSignal) {
    const key = JSON.stringify(record);
    if (pendingSave.current?.key !== key) pendingSave.current = { key, id: crypto.randomUUID() };
    await checkpointRequest('/api/v1/checkpoints', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...record, id: pendingSave.current.id }) });
    onChange();
  }
  async function confirmRead(row: ScreenCheckpoint) {
    if (!row.readingSection || working) return;
    setWorking(true); setActionError('');
    try { await confirmReadingBookmark(row.id, row.readingSection); onChange(); }
    catch (err) { setActionError((err as Error).message); }
    finally { setWorking(false); }
  }
  async function remove(id: string) {
    setWorking(true); setActionError('');
    try {
      await checkpointRequest('/api/v1/checkpoints', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      setRemoving(''); onChange();
    } catch (err) { setActionError((err as Error).message); }
    finally { setWorking(false); }
  }
  const formatTime = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone });
  function renderRow(row: ScreenCheckpoint) {
    return <li key={row.id}>
        <div className="checkpoint-meta">
          <time dateTime={row.capturedAt}>{formatTime.format(new Date(row.capturedAt))}</time>
          {row.appName && <strong>{row.appName}</strong>}
          <span>{checkpointSourceLabel(row.source)}</span>
          {row.detailSource === 'window-title' && <span>来自窗口标题</span>}
        </div>
        {row.pageTitle && <h3 className="checkpoint-page">{row.pageTitle}</h3>}
        {(!row.pageTitle || row.detailSource !== 'window-title') && <p className="checkpoint-summary">{row.summary}</p>}
        <p className="checkpoint-task">{row.taskId ? '关联任务　' + (tasks.find(task => task.id === row.taskId)?.title ?? '已移除的任务') : '未关联任务'}</p>
        {row.readingPosition && <p>阅读位置　第 {row.readingPosition.page} / {row.readingPosition.total} 页</p>}
        {row.readingSection && <p>阅读书签　{row.readingSection}　{row.readingConfirmed ? '已确认读完' :
          <button type="button" disabled={working} onClick={() => void confirmRead(row)}>确认已读 {row.readingSection}</button>}</p>}
        {!!row.completedParts?.length && <p>已完成　{row.completedParts.join('、')}</p>}
        {row.nextStep && <p>下一步　{row.nextStep}</p>}
        {row.progress && <p>进度 {row.progress.percent}% · {row.progress.evidence}</p>}
        {removing === row.id ? <div className="checkpoint-delete-confirm">
          <button type="button" disabled={working} onClick={() => remove(row.id)}>确认删除</button>
          <button type="button" disabled={working} onClick={() => setRemoving('')}>取消</button></div>
          : <button type="button" className="checkpoint-remove" onClick={() => setRemoving(row.id)}>删除记录</button>}
    </li>;
  }
  const recent = history?.records[0];
  return <details className="checkpoint-workspace" id="record">
    <summary className="checkpoint-disclosure"><strong>记录时间线</strong>
      <span>{recent ? [recent.appName, recent.pageTitle || recent.summary, !recent.taskId && '未关联任务'].filter(Boolean).join(' · ') :
        readError ? '时间线读取失败' : recorder.status?.state === 'recording' ? '正在等待记录' : '查看与补记'}</span>
    </summary>
    <section className="checkpoint-history" aria-labelledby="timeline-title">
      <h3 id="timeline-title" className="sr-only">记录时间线</h3>
      {readError && <p className="checkpoint-error" role="alert">时间线读取失败。{readError} <button type="button" onClick={load}>重试</button></p>}
      {actionError && <p className="checkpoint-error" role="alert">{actionError}</p>}
      {!history && !readError && <p role="status">正在读取记录…</p>}
      {history?.records.length === 0 && !readError && <p className="checkpoint-empty">
        {recorder.status?.state === 'recording' ? '正在等待第一条记录。' : '还没有记录。开始后，使用过的应用和页面会出现在这里。'}
      </p>}
      {!!history?.records.length && <ol className="checkpoint-timeline">{renderRow(history.records[0])}</ol>}
      {history && (history.records.length > 1 || history.hasMore) && <details className="checkpoint-older">
        <summary>查看更早的记录</summary>
        <ol className="checkpoint-timeline">{history.records.slice(1).map(renderRow)}</ol>
      {history?.hasMore && limit < 1000 && <button type="button" className="checkpoint-earlier" disabled={loading}
        onClick={() => setLimit(current => Math.min(1000, current + 12))}>{loading ? '正在读取…' : '显示更早的记录'}</button>}
      </details>}
    </section>
    <details className="checkpoint-manual"><summary>手动补记截图</summary><ScreenObservation tasks={tasks} onSave={save} /></details>
  </details>;
}
