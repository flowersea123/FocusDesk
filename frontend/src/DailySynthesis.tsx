import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { checkpointSourceLabel, type CheckpointSource } from '../../contracts/screen-checkpoint';
import type { FocusReview, ReviewObservation } from '../../contracts/focus-review';
import './daily-review.css';

interface Digest {
  summary: string;
  evidence: { at: string; summary: string; source?: CheckpointSource }[];
  suggestion: string;
  used: number;
  total: number;
}

const updateInterval = 60_000;
const pending = new Map<string, Promise<Digest>>();
interface DatedDigest {
  date: string;
  through: string;
  digest: Digest;
}

const completed = new Map<string, DatedDigest>();
const observed = new Map<string, { key: string; count: number; minimum: number }>();
const listeners = new Set<() => void>();
let completionVersion = 0;
const readVersion = () => completionVersion;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const lastStarted = new Map<string, number>();

export function synthesisKey(review: FocusReview | null) {
  return review?.observations.length ? JSON.stringify([review.date, review.observations]) : '';
}

function remember<T>(entries: Map<string, T>, key: string, value: T) {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > 16) entries.delete(entries.keys().next().value!);
}

function prefixKey(review: FocusReview, count: number) {
  return JSON.stringify([review.date, review.observations.slice(0, count)]);
}

// An edit or deletion starts a new chain. Late replies can only cover an intact prefix of this chain.
function minimumRetainedCount(review: FocusReview, key: string) {
  const count = review.observations.length;
  const previous = observed.get(review.date);
  if (previous && (previous.key === key || (previous.count < count && previous.key === prefixKey(review, previous.count)))) {
    return previous.minimum;
  }
  return count;
}

function latestPrefix(review: FocusReview, minimum: number) {
  let best: DatedDigest | undefined;
  for (const [key, entry] of completed) {
    const count = entry.digest.total;
    if (entry.date === review.date && count >= minimum && count < review.observations.length &&
        count > (best?.digest.total ?? 0) && key === prefixKey(review, count)) best = entry;
  }
  return best;
}

async function generate(date: string, key: string, observations: ReviewObservation[]): Promise<Digest> {
  const response = await fetch('/api/v1/focus-review/synthesis', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }), signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw Error();
  const data = await response.json();
  // A capture or edit can land between reading the review and requesting the digest.
  if (data.observationRevision !== undefined) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const revision = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (data.observationRevision !== revision) throw Error();
  }
  // Older Hubs do not return a revision. Check their referenced text and count too.
  const matches = (item: Digest['evidence'][number]) => item && observations.some(o =>
    o.at === item.at && o.summary === item.summary && (o.source ?? 'manual') === (item.source ?? 'manual'));
  if (typeof data.summary !== 'string' || !data.summary.trim() || typeof data.suggestion !== 'string' ||
      data.total !== observations.length || !Number.isInteger(data.used) || data.used < 1 || data.used > data.total ||
      !Array.isArray(data.evidence) || !data.evidence.length || !data.evidence.every(matches)) throw Error();
  return data;
}

function request(date: string, key: string, observations: ReviewObservation[]) {
  const existing = pending.get(key);
  if (existing) return existing;
  remember(lastStarted, date, Date.now());
  const result = generate(date, key, observations)
    .then(digest => {
      const through = observations.reduce((latest, row) => Date.parse(row.at) > Date.parse(latest) ? row.at : latest, observations[0].at);
      remember(completed, key, { date, through, digest });
      completionVersion++;
      listeners.forEach(listener => listener());
      return digest;
    })
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

export default function DailySynthesis({ active = true, review, onSuggestion }: {
  active?: boolean;
  review: FocusReview | null;
  onSuggestion?: (value: FocusReview['suggestion'], key: string) => void;
}) {
  const heading = useId();
  const date = review?.date;
  const key = synthesisKey(review);
  const [failedKey, setFailedKey] = useState('');
  useSyncExternalStore(subscribe, readVersion);
  const count = review?.observations.length ?? 0;
  const minimum = review ? minimumRetainedCount(review, key) : count;
  const exact = completed.get(key);
  const earlier = !exact && review && minimum < count ? latestPrefix(review, minimum) : undefined;
  const digest = (exact ?? earlier)?.digest;
  const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: review?.timezone });
  const cutoff = earlier ? '截至 ' + clock.format(new Date(earlier.through)) : '';

  useLayoutEffect(() => {
    if (active && date) remember(observed, date, { key, count, minimum });
  }, [active, date, key, count, minimum]);

  useEffect(() => {
    if (!active || !review || !date || !key) return;
    const observations = review.observations;
    let listening = true;
    let timer = 0;
    async function update() {
      window.clearTimeout(timer);
      if (!listening || document.hidden) return;
      if (completed.has(key)) return;
      const remaining = (lastStarted.get(date!) ?? -Infinity) + updateInterval - Date.now();
      if (remaining > 0 && !pending.has(key)) {
        timer = window.setTimeout(update, remaining);
        return;
      }
      try {
        await request(date!, key, observations);
        if (listening) setFailedKey('');
      } catch {
        if (listening) {
          setFailedKey(key);
          window.clearTimeout(timer);
          timer = window.setTimeout(update, updateInterval);
        }
      }
    }
    void update();
    document.addEventListener('visibilitychange', update);
    return () => {
      listening = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
    // The key includes every observation field and the date, independently of other review updates.
  }, [active, date, key]);

  useEffect(() => {
    const cited = digest?.evidence[0];
    onSuggestion?.(active && digest?.suggestion && cited ? {
      action: digest.suggestion, evidence: (cutoff ? cutoff + '，' : '') + '依据' + checkpointSourceLabel(cited.source) + '的屏幕观察：“' + cited.summary + '”',
    } : null, key);
  }, [active, cutoff, digest, key, onSuggestion]);

  if (!review) return null;
  const cited = digest?.evidence ?? review.observations.slice(-3);
  const unavailable = failedKey === key;
  return <section className="daily-synthesis" aria-labelledby={heading}>
    <header>
      <h2 id={heading}>{review.date === review.today ? '今日工作小结' : '当日工作小结'}</h2>
      {digest && <small>本机 AI 总结</small>}
    </header>
    <p>{digest?.summary ?? review.summary}</p>
    {cited.length > 0 && <details>
      <summary>{digest ? '查看依据 · ' + digest.used + ' / ' + digest.total + ' 条记录参与生成' : '查看当日记录摘录'}</summary>
      <ul>{cited.map((item, index) => <li key={index}>
        <small><time dateTime={item.at}>{clock.format(new Date(item.at))}</time> · {checkpointSourceLabel(item.source)}</small>
        <span>“{item.summary}”</span>
      </li>)}</ul>
    </details>}
    {earlier && <small className="synthesis-state" role="status">
      <time dateTime={earlier.through}>{cutoff}</time>{unavailable ? ' · 更新暂时失败，稍后自动重试。' : ' · 正在自动更新小结。'}
    </small>}
    {!digest && key && <small className="synthesis-state" role="status">
      {unavailable ? '暂用当日记录小结，稍后自动重试。' : 'AI 小结会根据当日屏幕记录自动更新。'}
    </small>}
    {!key && <small className="synthesis-state">有屏幕记录后会自动生成 AI 小结。</small>}
  </section>;
}
