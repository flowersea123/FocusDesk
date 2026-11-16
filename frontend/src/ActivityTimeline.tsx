import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Task } from '../../contracts/daily-overview';
import type { FocusReview } from '../../contracts/focus-review';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint';
import './activity-timeline.css';

interface Props {
  review: FocusReview | null;
  tasks?: readonly Pick<Task, 'id' | 'title'>[];
  revealApp?: { name: string; request: number } | null;
  error?: string;
  onRetry?: () => void;
}

type Entry = { id: string; kind: 'focus' | 'app' | 'observation'; start: number; end: number; seconds: number; detail: string; source?: string; taskId?: string | null };
type Track = { id: string; name: string; kind: 'focus' | 'app'; entries: Entry[]; seconds: number };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const shownTracks = 5;
const colors = ['#467eb1', '#ba713e', '#658753', '#a86689', '#3d8a81', '#947942', '#786da4', '#986154'];
const endLabels = {running:'计时中', stopped:'提前结束', expired:'自然到期', unobserved:'计至最后一次确认', continued:'延续至次日'};

export function formatActivityDuration(seconds: number) {
  const whole = Math.floor(Math.round(seconds * 1000) / 1000);
  const h = Math.floor(whole / 3600), m = Math.floor(whole / 60) % 60, s = h ? 0 : whole % 60;
  return [h ? h + ' 小时' : '', m ? m + ' 分' : '', s || (!h && !m) ? s + ' 秒' : ''].filter(Boolean).join(' ');
}

function dayBounds(date: string, zone: string) {
  const calendar = new Intl.DateTimeFormat('sv-SE', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit'});
  // Find the first actual instant of each local date, including days with offset changes.
  function startOf(utcDate: number) {
    const label = new Date(utcDate).toISOString().slice(0, 10);
    let before = utcDate - DAY * 2, after = utcDate + DAY * 2;
    while (after - before > 1) {
      const mid = Math.floor((before + after) / 2);
      if (calendar.format(mid) < label) before = mid;
      else after = mid;
    }
    return after;
  }
  const midnight = Date.parse(date + 'T00:00:00Z');
  return {begin:startOf(midnight), end:startOf(midnight + DAY)};
}

function buildTracks(review: FocusReview, day: ReturnType<typeof dayBounds>) {
  const tracks = new Map<string, Track>();
  function add(id: string, name: string, kind: Track['kind'], entry: Entry) {
    if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end) || entry.end < entry.start ||
        entry.start >= day.end || entry.end < day.begin || (entry.end === day.begin && entry.start < day.begin)) return;
    entry.start = Math.max(day.begin, entry.start);
    entry.end = Math.min(day.end, entry.end);
    entry.seconds = Math.min(entry.seconds, (entry.end - entry.start) / 1000);
    const track: Track = tracks.get(id) ?? {id, name, kind, entries:[], seconds:0};
    track.entries.push(entry);
    track.seconds += entry.seconds;
    tracks.set(id, track);
  }
  for (const [i, segment] of review.sessions.entries()) {
    add('task:' + segment.taskId, segment.title, 'focus', {id:'f' + segment.from + ':' + i, kind:'focus',
      start:Date.parse(segment.from), end:Date.parse(segment.to), seconds:segment.seconds, detail:endLabels[segment.end]});
  }
  for (const [i, segment] of (review.appSessions ?? []).entries()) {
    const name = segment.appName.trim();
    add('app:' + name, name || '未识别应用', 'app', {id:'a' + segment.from + ':' + i, kind:'app',
      start:Date.parse(segment.from), end:Date.parse(segment.to), seconds:segment.seconds, detail:'前台时段'});
  }
  for (const observation of review.observations) {
    const name = observation.appName?.trim();
    const at = Date.parse(observation.at);
    add(name ? 'app:' + name : 'observations', name || '屏幕观察', 'app', {id:'o' + observation.id, kind:'observation',
      start:at, end:at, seconds:0, detail:observation.summary, source:checkpointSourceLabel(observation.source), taskId:observation.taskId});
  }
  const rows = [...tracks.values()];
  for (const row of rows) row.entries.sort((a,b) => a.start - b.start || a.id.localeCompare(b.id));
  rows.sort((a,b) => Number(b.kind === 'focus') - Number(a.kind === 'focus') || b.seconds - a.seconds ||
    b.entries.length - a.entries.length || a.name.localeCompare(b.name, 'zh'));
  return rows;
}

function clusters(entries: Entry[], minGap: number) {
  const groups: Entry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && entry.start - last[0].start < minGap) last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

function trackColors(rows: Track[]) {
  const result = new Map<string, string>();
  const apps = rows.filter(row => row.kind === 'app').map(row => row.id).sort();
  const remaining = new Set(colors);
  for (const [index, id] of apps.entries()) {
    const seed = [...id].reduce((sum, char) => sum + char.codePointAt(0)!, 0);
    let slot = seed % colors.length;
    if (remaining.size) {
      while (!remaining.has(colors[slot])) slot = (slot + 1) % colors.length;
      result.set(id, colors[slot]);
      remaining.delete(colors[slot]);
    } else result.set(id, 'hsl(' + Math.round(index * 137.5) % 360 + ' 38% 44%)');
  }
  return result;
}

function Chart({review, tasks, revealApp, handled}: {
  review: FocusReview; tasks?: Props['tasks']; revealApp?: Props['revealApp']; handled: RefObject<Props['revealApp']>;
}) {
  const day = useMemo(() => dayBounds(review.date, review.timezone), [review.date, review.timezone]);
  const rows = useMemo(() => buildTracks(review, day), [review, day]);
  const palette = useMemo(() => trackColors(rows), [rows]);
  const clock = useMemo(() => new Intl.DateTimeFormat('zh-CN', {timeZone:review.timezone, hour:'2-digit',
    minute:'2-digit', hourCycle:'h23'}), [review.timezone]);
  const exact = useMemo(() => new Intl.DateTimeFormat('zh-CN', {timeZone:review.timezone, hour:'2-digit',
    minute:'2-digit', second:'2-digit', hourCycle:'h23'}), [review.timezone]);
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(12);
  const [selection, setSelection] = useState<{rowId:string; ids?:string[]} | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const ruler = useRef<HTMLDivElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(360);
  const detailsId = useId();
  useEffect(() => {
    if (!revealApp || (handled.current?.request === revealApp.request && handled.current.name === revealApp.name)) return;
    const index = rows.findIndex(row => row.id === 'app:' + revealApp.name.trim());
    if (index < 0) return;
    handled.current = revealApp;
    opener.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    if (index >= shownTracks) setAll(true);
    setLimit(12);
    setSelection({rowId:rows[index].id});
  }, [revealApp, rows, handled]);
  useEffect(() => { if (selection) detailHeading.current?.focus(); }, [selection]);
  const hasRows = rows.length > 0;
  useEffect(() => {
    if (!hasRows || !ruler.current) return;
    const node = ruler.current;
    function measure() {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setPlotWidth(width);
    }
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasRows]);
  if (!hasRows) return <p className="activity-empty">今天还没有活动记录。开启屏幕记录或开始一次专注计时后，时间轴会出现在这里。</p>;

  let earliest = day.end, latest = day.begin;
  for (const row of rows) for (const entry of row.entries) {
    earliest = Math.min(earliest, entry.start);
    latest = Math.max(latest, entry.end);
  }
  const start = day.begin + Math.floor((earliest - day.begin) / HOUR) * HOUR;
  const end = Math.min(day.end, Math.max(start + HOUR, day.begin + Math.ceil((latest - day.begin) / HOUR) * HOUR));
  const span = end - start;
  const percent = (at: number) => 100 * (at - start) / span;
  const time = (at: number, seconds = false) => at === day.end ? (seconds ? '24:00:00' : '24:00') : (seconds ? exact : clock).format(at);
  const visibleRows = all ? rows : rows.slice(0, shownTracks);
  const current = visibleRows.find(row => row.id === selection?.rowId);
  const selectedIds = selection?.ids && new Set(selection.ids);
  const details = current?.entries.filter(entry => !selectedIds || selectedIds.has(entry.id)) ?? [];
  function select(button: HTMLButtonElement, rowId: string, entries?: Entry[]) {
    opener.current = button;
    setLimit(12);
    setSelection({rowId, ids:entries?.map(e => e.id)});
  }
  function close() {
    setSelection(null);
    opener.current?.focus({preventScroll:true});
  }
  return <>
    <div className="activity-legend">
      <span><i className="activity-key-focus" />任务计时</span><span><i className="activity-key-app" />应用前台</span>
      <span><i className="activity-key-shot" />截图观察点</span>
      <span className="activity-latest-label"><i/>最近记录 <time dateTime={new Date(latest).toISOString()}>{time(latest)}</time></span>
    </div>
    <div className="activity-grid">
      <span className="activity-axis-heading">时间</span>
      <div className="activity-axis" ref={ruler} aria-label="时间刻度">
        {[0,.25,.5,.75,1].map(fraction => <span key={fraction} style={{left:(100 * fraction) + '%'}}>{time(start + fraction * span)}</span>)}
      </div>
      {visibleRows.map(row => {
        const spanEntries = row.entries.filter(e => e.kind !== 'observation');
        const points = row.entries.filter(e => e.kind === 'observation');
        const measure = row.kind === 'focus' ? '计时' : '前台';
        const color = row.kind === 'focus' ? '#7962a7' : palette.get(row.id);
        const trackStyle = {'--activity-color':color} as CSSProperties;
        return <div className="activity-row" key={row.id} style={trackStyle}>
          <button type="button" className="activity-name" aria-label={'查看 ' + row.name + ' 的全部记录'} aria-controls={detailsId}
            onClick={e => select(e.currentTarget, row.id)}>
            <strong title={row.name}>{row.name}</strong>
            <small className="activity-row-metrics">
              {spanEntries.length > 0 && <span>{measure} {formatActivityDuration(row.seconds)}</span>}
              {spanEntries.length > 0 && points.length > 0 && <span className="activity-metric-divider"> · </span>}
              {points.length > 0 && <span>{points.length} 条观察</span>}
            </small>
          </button>
          <div className="activity-track" role="group" aria-label={row.name + ' 时间轨道'}>
            <span className="activity-latest-line" style={{left:percent(latest) + '%'}} aria-hidden="true"/>
            {clusters(spanEntries, span * 22 / plotWidth).map(group => {
              const first = group[0].start, last = Math.max(...group.map(e => e.end));
              const label = row.name + ' · ' + measure + ' ' + time(first) + '–' + time(last) +
                ' · ' + formatActivityDuration(group.reduce((s,e) => s + e.seconds, 0)) + (group.length > 1 ? ' · ' + group.length + ' 段' : '');
              return <button type="button" className="activity-span" key={group[0].id} aria-label={label} title={label}
                aria-controls={detailsId} style={{left:percent(first) + '%', width:(percent(last) - percent(first)) + '%'}}
                onClick={e => select(e.currentTarget, row.id, group)}>
                {group.map(entry => <i key={entry.id} style={{left:(last > first ? 100 * (entry.start - first) / (last - first) : 0) + '%',
                  width:(last > first ? 100 * (entry.end - entry.start) / (last - first) : 0) + '%'}} />)}
              </button>;
            })}
            {clusters(points, span * 29 / plotWidth).map(group => {
              const label = row.name + ' · ' + time(group[0].start) + ' · ' + group.length + ' 条截图观察';
              return <button type="button" className="activity-point" key={group[0].id} title={label} aria-label={label}
                aria-controls={detailsId} style={{left:percent(group[0].start) + '%'}}
                onClick={e => select(e.currentTarget, row.id, group)}>
                <i aria-hidden="true" className={group.length > 1 ? 'is-cluster' : ''}>{group.length > 1 && (group.length > 99 ? '99+' : group.length)}</i>
              </button>;
            })}
          </div>
        </div>;
      })}
    </div>
    {rows.length > shownTracks && <button type="button" className="activity-more" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? '收起活动行' : '显示另外 ' + (rows.length - shownTracks) + ' 行'}</button>}
    <div id={detailsId} className={details.length ? 'activity-details' : undefined}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
      {current && details.length > 0 && <>
        <header><h3 tabIndex={-1} ref={detailHeading}>{current.name} · {details.length} 条记录</h3>
          <button type="button" className="activity-more" onClick={close}>收起明细</button></header>
        <ol>{details.slice(0,limit).map(entry => {
          const task = entry.taskId && tasks?.find(t => t.id === entry.taskId);
          return <li key={entry.id}><time dateTime={new Date(entry.start).toISOString()}>{time(entry.start,true)}
            {entry.kind !== 'observation' && '–' + time(entry.end,true)}</time>
            <div>{entry.kind !== 'observation' && <strong>{entry.kind === 'focus' ? '计时 ' : '前台 '}{formatActivityDuration(entry.seconds)} · </strong>}
              {entry.detail}{entry.kind === 'observation' && <small>{entry.source}{task ? ' · ' + task.title : ''}</small>}</div>
          </li>;
        })}</ol>
        {details.length > limit && <button type="button" className="activity-more" onClick={() => setLimit(limit + 24)}>显示更多明细</button>}
      </>}
    </div>
  </>;
}

export default function ActivityTimeline({review, tasks, revealApp, error, onRetry}: Props) {
  const heading = useId();
  const handled = useRef<Props['revealApp']>(null);
  return <section className="activity-timeline" aria-labelledby={heading}>
    <header className="activity-header"><h2 id={heading}>今日活动时间轴</h2>
      {review && <span><time dateTime={review.date}>{review.date}</time> · {review.timezone}</span>}
    </header>
    {error && <p role="alert" className="activity-error">活动记录读取失败。{error} {onRetry &&
      <button type="button" className="activity-more" onClick={onRetry}>重试</button>}</p>}
    {review ? <Chart key={review.date + review.timezone} review={review} tasks={tasks} revealApp={revealApp} handled={handled}/> :
      !error && <p className="activity-empty" role="status">正在读取今日活动…</p>}
  </section>;
}
