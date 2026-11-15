import "./checkpoint-workspace.css";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOverview } from '../../contracts/daily-overview';
import { checkpointSourceLabel, type ScreenCheckpoint, type CheckpointHistory } from '../../contracts/screen-checkpoint';
import ScreenObservation from './ScreenObservation';

export async function checkpointRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '本机服务未能完成请求。');
  return result;
}
export function CheckpointWorkspace({ overview, onChange }: { overview: DailyOverview; onChange?: () => void }) {
  const [history, setHistory] = useState<CheckpointHistory>({ records: [] });
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  const [working, setWorking] = useState(false);
  const pendingSave = useRef<{ key: string; id: string } | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await checkpointRequest<CheckpointHistory>('/api/v1/checkpoints');
      if (request === sequence.current) { setHistory(result); setError(''); }
    } catch (err) { if (request === sequence.current) setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);

  async function save(record: Omit<ScreenCheckpoint, 'id'>, signal?: AbortSignal) {
    const key = JSON.stringify(record);
    if (pendingSave.current?.key !== key) pendingSave.current = { key, id: crypto.randomUUID() };
    await checkpointRequest('/api/v1/checkpoints', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...record, id: pendingSave.current.id }) });
    await load();
    onChange?.();
  }
  async function remove(id: string) {
    setWorking(true);
    try {
      await checkpointRequest('/api/v1/checkpoints', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      setRemoving(''); await load(); onChange?.();
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }
  return <div className="checkpoint-workspace" id="screen-workspace">
    <ScreenObservation tasks={overview.tasks} onSave={save} />
    {!!error && <p role="alert">{error} <button type="button" onClick={load}>重试</button></p>}
    {history.records.length > 0 && <section className="checkpoint-history" aria-label="最近检查点">
      <h3>最近检查点</h3>
      {history.records.map(row => <article key={row.id}>
        <div className="checkpoint-meta"><time dateTime={row.capturedAt}>{new Date(row.capturedAt).toLocaleString('zh-CN',{ month:'numeric', day:'numeric', hour:'2-digit',minute:'2-digit',timeZone:overview.timezone })}</time>
          <span>{checkpointSourceLabel(row.source)}</span>
          {row.taskId && <span>{overview.tasks.find(t => t.id === row.taskId)?.title ?? '已移除的任务'}</span>}</div>
        <strong>{row.summary}</strong>
        {!!row.completedParts?.length && <p>已完成　{row.completedParts.join('、')}</p>}
        {row.nextStep && <p>下一步　{row.nextStep}</p>}
        {row.progress && <p>进度 {row.progress.percent}% · {row.progress.evidence}</p>}
        {removing === row.id ? <div><button type="button" disabled={working} onClick={() => remove(row.id)}>确认删除</button> <button type="button" onClick={() => setRemoving('')}>取消</button></div>
          : <button type="button" className="checkpoint-remove" onClick={() => setRemoving(row.id)}>删除记录</button>}
      </article>)}
    </section>}
  </div>;
}
