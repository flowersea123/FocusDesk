import { useEffect, useRef, useState } from 'react';
import { checkpointSourceLabel, type CheckpointSource } from '../../contracts/screen-checkpoint';
import type { FocusReview } from '../../contracts/focus-review';

interface Digest {
  summary: string;
  evidence: { at: string; summary: string; source?: CheckpointSource }[];
  suggestion: string;
  used: number;
  total: number;
}

export default function DailySynthesis({ date, revisionKey, onSuggestion }: {
  date: string;
  revisionKey?: string | number;
  onSuggestion: (value: FocusReview['suggestion']) => void;
}) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    setDigest(null);
    setMessage('');
    setBusy(false);
    onSuggestion(null);
    return () => active.current?.abort();
  }, [date, revisionKey, onSuggestion]);

  async function generate() {
    if (busy) return;
    const control = new AbortController();
    active.current = control;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/v1/focus-review/synthesis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
        signal: control.signal,
      });
      const data = await response.json();
      if (!response.ok) throw Error(typeof data.error === 'string' ? data.error : '未能生成回顾。');
      if (!control.signal.aborted) {
        setDigest(data);
        onSuggestion(data.suggestion ? { action: data.suggestion, evidence: '来自本次 AI 小结，可展开上方依据核对。' } : null);
      }
    } catch (error) {
      if (!control.signal.aborted) setMessage((error as Error).message);
    } finally {
      if (!control.signal.aborted) setBusy(false);
    }
  }

  return <section className="daily-synthesis">
    <button type="button" disabled={busy} onClick={generate}>{busy ? '本机模型整理中…' : digest ? '重新生成 AI 小结' : '生成 AI 小结'}</button>
    {message && <p role="status">{message}</p>}
    {digest && <div>
      <h4>今天做了什么</h4>
      <p>{digest.summary}</p>
      <details>
        <summary>依据 · {digest.used} / {digest.total} 条当日记录参与生成</summary>
        <ul>{digest.evidence.map((item, i) => <li key={i}>{checkpointSourceLabel(item.source)} · {item.summary}</li>)}</ul>
      </details>
    </div>}
  </section>;
}
