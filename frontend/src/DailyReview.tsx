import { useEffect, useRef, useState } from 'react';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint';
import type { FocusReview } from '../../contracts/focus-review';
import DailySynthesis from './DailySynthesis';
import './daily-review.css';

const endpoint = '/api/v1/focus-review';
const endLabel = { running: '计时中', stopped: '提前结束', expired: '自然到期', unobserved: '仅计至最后一次确认', continued: '延续至次日' };

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (!minutes) return seconds + ' 秒';
  const hours = Math.floor(minutes / 60);
  if (hours) return hours + ' 小时 ' + (minutes % 60) + ' 分';
  return minutes + ' 分' + (seconds % 60 ? ' ' + seconds % 60 + ' 秒' : '');
}

async function responseMessage(response: Response) {
  try {
    const body = await response.json();
    if (typeof body.error === 'string') return body.error;
    if (typeof body.error?.message === 'string') return body.error.message;
    if (typeof body.message === 'string') return body.message;
  } catch { /* Some local proxies respond with text when the Hub is down. */ }
  return 'Hub 请求失败（' + response.status + '）。';
}

function Experiment({ review, refresh, changeDate }: { review: FocusReview; refresh: () => void; changeDate: (date: string) => void }) {
  const base = review.experiment ?? { plan: '', outcome: '', revision: 'none' };
  const [draft, setDraft] = useState<{ plan: string; outcome: string; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const current = draft ?? base;
  const conflict = draft !== null && draft.revision !== base.revision;
  useEffect(() => () => request.current?.abort(), []);

  function edit(change: Partial<Pick<typeof current, 'plan' | 'outcome'>>) {
    setMessage('');
    setDraft({ ...current, ...change });
  }

  async function save() {
    if (!draft || conflict || !draft.plan.trim() || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(endpoint + '/experiment', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, date: review.date }), signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 409) refresh();
        throw new Error(await responseMessage(response));
      }
      if (!controller.signal.aborted) {
        setDraft(null); setFailed(false); setMessage('实验已保存。'); refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailed(true); setMessage(error instanceof Error ? error.message : '保存失败，请重试。');
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section className="review-experiment" aria-labelledby="review-experiment-title">
    <h3 id="review-experiment-title">我的改进实验</h3>
    {review.previousExperimentDate && <button className="review-link" type="button"
      onClick={() => changeDate(review.previousExperimentDate!)}>复查 {review.previousExperimentDate} 的实验 ↗</button>}
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      {!current.plan && review.suggestion && review.suggestion.action.length <= 240 &&
        <button type="button" className="review-link" onClick={() => edit({ plan: review.suggestion!.action })}>用上面的建议填写计划</button>}
      <label>下一次尝试
        <textarea value={current.plan} disabled={busy} maxLength={240} rows={2}
          placeholder="例如：写报告前先列三条结论，计时结束时检查写完了几条。"
          onChange={e => edit({ plan: e.target.value })} />
      </label>
      <label>复查结果 <span>（可稍后填写）</span>
        <textarea value={current.outcome} disabled={busy} maxLength={480} rows={2}
          placeholder="实际做到了什么？下次保留或调整什么？" onChange={e => edit({ outcome: e.target.value })} />
      </label>
      {conflict && <div className="review-conflict" role="alert">
        <p>这项实验刚在其他窗口更新。最新计划为“{base.plan}”。</p>
        {base.outcome && <p>最新复查结果为“{base.outcome}”。</p>}
        <button type="button" onClick={() => { setDraft(null); setMessage(''); }}>读取最新记录</button>
        <button type="button" onClick={() => { setDraft({ ...current, revision: base.revision }); setMessage(''); }}>保留我的草稿</button>
      </div>}
      <div className="review-save">
        <button type="submit" disabled={!draft || !draft.plan.trim() || busy || conflict}>{busy ? '正在保存…' : '保存实验'}</button>
        {message && <span role={failed ? 'alert' : 'status'}>{message}</span>}
      </div>
    </form>
  </section>;
}

export default function DailyReview({ refreshKey }: { refreshKey?: string | number }) {
  const [date, setDate] = useState('');
  const [aiSuggestion, setAISuggestion] = useState<FocusReview['suggestion']>(null);
  const [version, setVersion] = useState(0);
  const [review, setReview] = useState<FocusReview | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);
  const refresh = () => setVersion(v => v + 1);

  useEffect(() => {
    const controller = new AbortController();
    const ticket = ++latest.current;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    async function read() {
      try {
        const response = await fetch(endpoint + (date ? '?date=' + encodeURIComponent(date) : ''),
          { credentials: 'same-origin', cache: 'no-store', signal });
        if (!response.ok) throw new Error(await responseMessage(response));
        const result = await response.json() as FocusReview;
        if (controller.signal.aborted || latest.current !== ticket) return;
        setReview(result); setError('');
      } catch (issue) {
        if (controller.signal.aborted || latest.current !== ticket) return;
        setError(issue instanceof Error ? issue.message : '无法读取回顾。');
      }
    }
    void read();
    return () => controller.abort();
  }, [date, version, refreshKey]);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(onVisible, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, []);

  const current = review && (!date || review.date === date) ? review : null;
  const suggestion = aiSuggestion ?? current?.suggestion ?? null;
  const clock = current && new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: current.timezone });
  return <section className="daily-review" aria-labelledby="daily-review-title">
    <header className="review-heading">
      <h2 id="daily-review-title">每日回顾</h2>
      <div className="review-date">
        <label>回顾日期 <input aria-label="回顾日期" type="date" value={date || review?.date || ''}
          max={review?.today} onChange={e => { setError(''); setDate(e.target.value); }} /></label>
        {date && date !== review?.today && <button type="button" className="review-link" onClick={() => setDate('')}>今天</button>}
      </div>
    </header>
    {error && <p className="review-error" role="alert">回顾读取失败。{error} <button className="review-link" onClick={refresh}>重试</button></p>}
    {!current && !error && <p role="status">正在读取回顾…</p>}
    {current && <>
      <div className="review-metrics">
        <div><span>专注计时</span><strong>{duration(current.totalSeconds)}</strong></div>
        <div><span>计时段数</span><strong>{current.sessions.length}</strong></div>
        <div><span>屏幕观察</span><strong>{current.observations.length}</strong></div>
      </div>
      <p className="review-summary">{current.summary}</p>
      {current.partial && <p className="review-note">专注计时可追溯至 {new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: current.timezone,
      }).format(new Date(current.trackingSince))}（{current.timezone}）。</p>}
      {current.sessions.length > 0 && <details className="review-evidence"><summary>查看计时段</summary>
        <ul>{current.sessions.map(s => <li key={s.taskId + s.from}>
          <span className="review-time">{clock!.format(new Date(s.from))}–{clock!.format(new Date(s.to))}</span>
          <span><strong>{s.title}</strong><small>{duration(s.seconds)} · {endLabel[s.end]}</small></span>
        </li>)}</ul></details>}
      {current.observations.length > 0 && <details className="review-evidence"><summary>查看屏幕观察</summary>
        <ul>{current.observations.map(o => <li key={o.id}><span className="review-time">{clock!.format(new Date(o.at))}</span>
          <span>{o.summary}<small>{checkpointSourceLabel(o.source)}</small></span></li>)}</ul></details>}
      <DailySynthesis date={current.date} revisionKey={current.observations.map(o => o.id).join(',')} onSuggestion={setAISuggestion}/>
      {suggestion && <aside className="review-suggestion"><h3>下次可以试试</h3><p>{suggestion.action}</p>
        <small>{suggestion.evidence}</small></aside>}
      <Experiment key={current.date} review={{ ...current, suggestion }} refresh={refresh} changeDate={setDate}/>
    </>}
  </section>;
}
