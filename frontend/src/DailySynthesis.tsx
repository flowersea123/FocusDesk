import { workspaceClock } from './data/workspace-clock';
import { useEffect, useId, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { checkpointSourceLabel, type CheckpointSource } from '../../contracts/screen-checkpoint';
import type { FocusReview } from '../../contracts/focus-review';
import { synthesisEvidence, type SynthesisObservation } from '../../contracts/daily-synthesis';
import './daily-review.css';

interface Digest {
  method?: 'recorded';
  summary: string;
  evidence: { at: string; summary: string; source?: CheckpointSource; sourceLabel?: string }[];
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

function useSynthesisInput(review: FocusReview | null) {
  const observations = useMemo(() => review ? synthesisEvidence(review) : [],
    [review?.observations, review?.workActivities]);
  const date = review?.date;
  const key = useMemo(() => observations.length ? JSON.stringify([date, observations]) : '', [date, observations]);
  return { observations, key };
}

export function useSynthesisKey(review: FocusReview | null) {
  return useSynthesisInput(review).key;
}

function originLabel(item: Digest['evidence'][number]) {
  return item.sourceLabel || checkpointSourceLabel(item.source);
}

function remember<T>(entries: Map<string, T>, key: string, value: T) {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > 16) entries.delete(entries.keys().next().value!);
}

function prefixKey(date: string, observations: SynthesisObservation[], count: number) {
  return JSON.stringify([date, observations.slice(0, count)]);
}

// An edit or deletion starts a new chain. Late replies can only cover an intact prefix of this chain.
function minimumRetainedCount(date: string, observations: SynthesisObservation[], key: string) {
  const count = observations.length;
  const previous = observed.get(date);
  if (previous && (previous.key === key || (previous.count < count && previous.key === prefixKey(date, observations, previous.count)))) {
    return previous.minimum;
  }
  return count;
}

function latestPrefix(date: string, observations: SynthesisObservation[], minimum: number) {
  let best: DatedDigest | undefined;
  for (const [key, entry] of completed) {
    const count = entry.digest.total;
    if (entry.date === date && count >= minimum && count < observations.length &&
        count > (best?.digest.total ?? 0) && key === prefixKey(date, observations, count)) best = entry;
  }
  return best;
}

async function generate(date: string, key: string, observations: SynthesisObservation[]): Promise<Digest> {
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
    o.at === item.at && o.summary === item.summary && (o.source ?? 'manual') === (item.source ?? 'manual') && o.sourceLabel === item.sourceLabel);
  if (typeof data.summary !== 'string' || !data.summary.trim() || typeof data.suggestion !== 'string' ||
      data.total !== observations.length || !Number.isInteger(data.used) || data.used < 1 || data.used > data.total ||
      !Array.isArray(data.evidence) || !data.evidence.length || !data.evidence.every(matches)) throw Error();
  return data;
}

function request(date: string, key: string, observations: SynthesisObservation[]) {
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
  const { observations, key } = useSynthesisInput(review);
  const [failedKey, setFailedKey] = useState('');
  useSyncExternalStore(subscribe, readVersion);
  const count = observations.length;
  const minimum = date ? minimumRetainedCount(date, observations, key) : count;
  const exact = completed.get(key);
  const earlier = !exact && date && minimum < count ? latestPrefix(date, observations, minimum) : undefined;
  const digest = (exact ?? earlier)?.digest;
  const clock = workspaceClock(review?.timezone);
  const cutoff = earlier ? '截至 ' + clock.format(new Date(earlier.through)) : '';

  useLayoutEffect(() => {
    if (active && date) remember(observed, date, { key, count, minimum });
  }, [active, date, key, count, minimum]);

  useEffect(() => {
    if (!active || !review || !date || !key) return;
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
      action: digest.suggestion, evidence: (cutoff ? cutoff + '，' : '') + '依据' + originLabel(cited) + '：“' + cited.summary + '”',
    } : null, key);
  }, [active, cutoff, digest, key, onSuggestion]);

  if (!review) return null;
  const cited = digest?.evidence ?? observations.slice(-3);
  const unavailable = failedKey === key;
  return <section className="daily-synthesis" aria-labelledby={heading}>
    <header>
      <h2 id={heading}>{review.date === review.today ? '今日工作小结' : '当日工作小结'}</h2>
      {digest && <small>{digest.method === 'recorded' ? '按记录汇总' : '本机 AI 总结'}</small>}
    </header>
    {(digest || !review.workActivities?.length) && <p>{digest?.summary ?? review.summary}</p>}
    {!!review.workActivities?.length && <WorkActivities key={review.date} groups={review.workActivities} clock={clock}/>}
    {cited.length > 0 && <details>
      <summary>{digest ? '查看依据 · ' + digest.used + ' / ' + digest.total + ' 条记录参与生成' : '查看当日记录摘录'}</summary>
      <ul>{cited.map((item, index) => <li key={index}>
        <small><time dateTime={item.at}>{clock.format(new Date(item.at))}</time> · {originLabel(item)}</small>
        <span>“{item.summary}”</span>
      </li>)}</ul>
    </details>}
    {earlier && <small className="synthesis-state" role="status">
      <time dateTime={earlier.through}>{cutoff}</time>{unavailable ? ' · 更新暂时失败，稍后自动重试。' : ' · 正在自动更新小结。'}
    </small>}
    {!digest && key && <small className="synthesis-state" role="status">
      {unavailable ? '暂用当日记录小结，稍后自动重试。' : '小结会根据当日活动记录自动更新。'}
    </small>}
    {!key && !review.workActivities?.length && <small className="synthesis-state">有活动记录后会自动生成小结。</small>}
  </section>;
}

type WorkGroup = NonNullable<FocusReview['workActivities']>[number];
const questionLabel = /^(?:第\s*[零〇一二三四五六七八九十百千万两\d.]+\s*题|(?:习题|练习题?|题目|题)\s*[零〇一二三四五六七八九十百千万两\d.]+|(?:q|question|problem|exercise)\.?\s*#?\s*\d+(?:\.\d+)*)(?:\s*[:：（(].*)?$/iu;

function WorkActivities({ groups, clock }: { groups: WorkGroup[]; clock: Intl.DateTimeFormat }) {
  const [expanded, setExpanded] = useState(false);
  const list = useId();
  let visible = groups;
  if (!expanded && groups.length > 6) {
    const materials = groups.filter(group => group.completedItems.length || group.answeredItems?.length ||
      group.events.some(e => e.kind !== 'discussion'));
    const preview = new Set(materials.slice(0, 6));
    for (const group of groups) {
      if (preview.size >= 6) break;
      preview.add(group);
    }
    visible = groups.filter(group => preview.has(group));
  }
  return <div className="review-work-activities" role="group" aria-label="当天做了什么">
    <div id={list}>{visible.map(group =>
      <WorkActivity key={JSON.stringify([group.title, group.events[0]?.at, group.events[0]?.source])} activity={group} clock={clock}/>
    )}</div>
    {groups.length > 6 && <button type="button" className="work-expand" aria-expanded={expanded} aria-controls={list}
      onClick={() => setExpanded(!expanded)}>{expanded ? '收起活动' : '查看全部 ' + groups.length + ' 项活动'}</button>}
  </div>;
}

function previewEvents(events: WorkGroup['events']) {
  if (events.length <= 4) return events;
  const chosen = new Set([events[0], events[events.length - 1]]);
  for (const kind of ['work', 'reading', 'discussion']) {
    const first = events.find(event => event.kind === kind);
    if (first) chosen.add(first);
  }
  for (const event of events) {
    if (chosen.size >= 4) break;
    chosen.add(event);
  }
  return events.filter(event => chosen.has(event));
}

function WorkItems({ rows, answered = false }: { rows: WorkGroup['completedItems']; answered?: boolean }) {
  if (!rows.length) return null;
  const items = new Map<string, Set<string>>();
  for (const { document, label } of rows) {
    const list = items.get(document) ?? new Set<string>();
    list.add(label);
    items.set(document, list);
  }
  const labels = Array.from(items.values()).flatMap(group => [...group]);
  const unit = labels.every(label => questionLabel.test(label)) ? '道题' : '项';
  const heading = (answered ? '有作答记录 ' : '屏幕显示已完成 ') + labels.length + ' ' + unit;
  return <div className="work-items" role="group" aria-label={heading}>
    <span className="work-completion-count">{heading}</span>
    {answered && <small>未见完成标记</small>}
    <dl className="work-completed-items">
      {Array.from(items, ([document, group]) => <div key={document}>
        <dt>{document}</dt><dd>{Array.from(group).join('、')}</dd>
      </div>)}
    </dl>
  </div>;
}

function WorkActivity({ activity, clock }: { activity: WorkGroup; clock: Intl.DateTimeFormat }) {
  const heading = useId();
  const history = useId();
  const [expanded, setExpanded] = useState(false);
  const events = [...activity.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const visible = expanded ? events : previewEvents(events);
  return <article className="review-work-group" aria-labelledby={heading}>
    <h3 id={heading}>{activity.title}</h3>
    <WorkItems rows={activity.completedItems}/>
    {activity.answeredItems && <WorkItems rows={activity.answeredItems} answered/>}
    {events.length > 0 && <ol id={history} className="work-history" aria-label={activity.title + '的活动顺序'}>
      {visible.map((event, i) => <li key={event.at + '-' + i}>
        <details><summary>
          <time dateTime={event.at}>{clock.format(new Date(event.at))}</time>
          <small className="work-event-source">{event.source}</small>
          <span>{event.text}</span>
        </summary>
        <p><q>{event.evidence}</q></p>
        </details>
      </li>)}
    </ol>}
    {events.length > 4 && <button type="button" className="work-expand" aria-expanded={expanded} aria-controls={history}
      onClick={() => setExpanded(!expanded)}>{expanded ? '收起时间记录' : '查看全部 ' + events.length + ' 条时间记录'}</button>}
  </article>;
}
