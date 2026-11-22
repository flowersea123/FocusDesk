import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { RecorderControls } from './ForegroundRecord';
import type { Task } from '../../contracts/daily-overview';
import type { FocusReview } from '../../contracts/focus-review';
import { groupAiConversations, type AiConversation } from '../../contracts/ai-conversations';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint';
import ActivityOverview from './ActivityOverview';
import './activity-timeline.css';

interface Props {
  review: FocusReview | null;
  historical?: boolean;
  recorder?: RecorderControls;
  tasks?: readonly Pick<Task, 'id' | 'title'>[];
  revealApp?: { name: string; request: number } | null;
  error?: string;
  onRetry?: () => void;
}

export type TimelineEntry = { id: string; kind: 'focus' | 'app' | 'ai' | 'observation'; start: number; end: number; seconds: number; detail: string; source?: string; pageTitle?:string; observationGroup?: string; taskId?: string | null };
type Entry = TimelineEntry;
export type TimelineTrack = { id: string; name: string; kind: 'focus' | 'app' | 'ai'; entries: Entry[]; seconds: number; conversation?: AiConversation };
type Track = TimelineTrack;
const aiLabels = {running:'进行中', finished:'已结束', interrupted:'观测中断'};
const measureLabels = {focus:'计时', app:'前台', ai:'AI 活动'} as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const shownTracks = 5;
// The recorder normally revisits a stable page every 45 seconds. Use close samples only to
// show the first-to-last observation window; it never contributes to measured foreground time.
const observationGap = 60_000;
const colors = ['#467eb1', '#ba713e', '#658753', '#a86689', '#3d8a81', '#947942', '#786da4', '#986154'];
const endLabels = {running:'计时中', stopped:'提前结束', expired:'自然到期', unobserved:'计至最后一次确认', continued:'延续至次日'};

export function formatActivityDuration(seconds: number) {
  if (seconds > 0 && seconds < 1) return '不足 1 秒';
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
      start:Date.parse(segment.from), end:Date.parse(segment.to), seconds:(Date.parse(segment.to) - Date.parse(segment.from)) / 1000, detail:endLabels[segment.end]});
  }
  for (const [i, segment] of (review.appSessions ?? []).entries()) {
    const name = segment.appName.trim();
    add('app:' + name, name || '未识别应用', 'app', {id:'a' + segment.from + ':' + i, kind:'app',
      start:Date.parse(segment.from), end:Date.parse(segment.to), seconds:segment.seconds, detail:'前台时段'});
  }
  for (const chat of groupAiConversations(review.aiSessions ?? [])) {
    const id = 'ai:' + chat.key, name = chat.appName + ' · ' + chat.title;
    if (chat.linked) {
      add(id, name, 'ai', {id, kind:'ai', start:chat.from, end:chat.to, seconds:chat.activeSeconds, detail:aiLabels[chat.state]});
    } else {
      for (const window of chat.windows) add(id, name, 'ai', {id:id + ':' + window.from, kind:'ai', start:window.from, end:window.to,
        seconds:(window.to - window.from)/1000, detail:aiLabels[chat.state]});
    }
    const track = tracks.get(id);
    if (track) track.conversation = chat;
  }
  const foreground = (review.appSessions ?? []).map(s => ({name:s.appName.trim(), from:Date.parse(s.from), to:Date.parse(s.to)}))
    .sort((a,b) => a.from - b.from);
  const observations = review.observations.map(o => ({o, at:Date.parse(o.at)})).filter(({at}) => at >= day.begin && at < day.end)
    .sort((a,b) => a.at - b.at);
  let previous: {at:number; name:string; group:string; task?:string | null} | undefined;
  let spanIndex = 0;
  for (const {o, at} of observations) {
    const name = o.appName?.trim();
    let group = o.id;
    if (o.source === 'automatic' && name) {
      if (previous && previous.name === name && previous.task === o.taskId && at - previous.at <= observationGap) {
        while (spanIndex < foreground.length && foreground[spanIndex].to <= previous.at) spanIndex++;
        let otherApp = false;
        for (let j = spanIndex; j < foreground.length && foreground[j].from < at; j++) {
          if (foreground[j].name !== name) { otherApp = true; break; }
        }
        if (!otherApp) group = previous.group;
      }
      previous = {at, name, group, task:o.taskId};
    } else previous = undefined;
    add(name ? 'app:' + name : 'observations', name || '屏幕观察', 'app', {id:'o' + o.id, kind:'observation',
      start:at, end:at, seconds:0, pageTitle:o.pageTitle, observationGroup:group, detail:o.summary, source:checkpointSourceLabel(o.source), taskId:o.taskId});
  }
  const rows = [...tracks.values()];
  for (const row of rows) row.entries.sort((a,b) => a.start - b.start || a.id.localeCompare(b.id));
  rows.sort((a,b) => Number(b.kind === 'focus') - Number(a.kind === 'focus') || b.seconds - a.seconds ||
    b.entries.length - a.entries.length || a.name.localeCompare(b.name, 'zh'));
  return rows;
}

function observationRanges(entries: Entry[]) {
  const ranges = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = entry.observationGroup!;
    const range = ranges.get(key);
    if (range) range.push(entry);
    else ranges.set(key, [entry]);
  }
  return [...ranges.values()];
}

type Mark = {entries:Entry[]; from:number; to:number; left:number; right:number; enlarged:boolean};
type MarkGroup = {marks:Mark[]; left:number; right:number};

// Layout in pixels first so even a few seconds remains selectable on a day-long axis.
// Keep the true timestamps on each mark. If targets touch, open them through a shared button.
function placeMarks(ranges: Entry[][], start: number, span: number, plotWidth: number) {
  const layout: Mark[] = [];
  for (const entries of ranges) {
    const from = entries[0].start, to = entries.at(-1)!.end;
    const clippedFrom = Math.max(from, start), clippedTo = Math.min(to, start + span);
    if (clippedTo < clippedFrom || (clippedTo === clippedFrom && from !== to)) continue;
    const natural = plotWidth * (clippedTo - clippedFrom) / span;
    const badge = entries[0].kind === 'observation' && from === to;
    const width = Math.min(plotWidth, Math.max(badge ? 48 : 18, natural));
    const left = Math.max(0, Math.min(plotWidth - width, plotWidth * (clippedFrom - start) / span - (width - natural) / 2));
    layout.push({entries, from, to, left, right:left + width, enlarged:!badge && natural < width - .01});
  }
  const groups: MarkGroup[] = [];
  for (const mark of layout.sort((a,b) => a.left - b.left || a.from - b.from)) {
    const {left, right} = mark;
    const previous = groups.at(-1);
    if (previous && left < previous.right - .01) {
      previous.marks.push(mark);
      previous.left = Math.min(previous.left, left);
      previous.right = Math.max(previous.right, right);
    } else groups.push({marks:[mark],left,right});
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

function Chart({review, tasks, revealApp, handled, historical}: {
  review: FocusReview; tasks?: Props['tasks']; historical?: boolean; revealApp?: Props['revealApp']; handled: RefObject<Props['revealApp']>;
}) {
  const day = useMemo(() => dayBounds(review.date, review.timezone), [review.date, review.timezone]);
  const rows = useMemo(() => buildTracks(review, day), [review, day]);
  const palette = useMemo(() => trackColors(rows), [rows]);
  const clock = useMemo(() => new Intl.DateTimeFormat('zh-CN', {timeZone:review.timezone, hour:'2-digit',
    minute:'2-digit', hourCycle:'h23'}), [review.timezone]);
  const exact = useMemo(() => new Intl.DateTimeFormat('zh-CN', {timeZone:review.timezone, hour:'2-digit',
    minute:'2-digit', second:'2-digit', hourCycle:'h23'}), [review.timezone]);
  const subsecond = useMemo(() => new Intl.DateTimeFormat('zh-CN', {timeZone:review.timezone, hour:'2-digit',
    minute:'2-digit', second:'2-digit', fractionalSecondDigits:3, hourCycle:'h23'}), [review.timezone]);
  const [detailed, setDetailed] = useState(false);
  const [all, setAll] = useState(false);
  const [zoom, setZoom] = useState<{from:number; to:number} | null>(null);
  const resetZoom = useRef<HTMLButtonElement | null>(null);
  const [limit, setLimit] = useState(12);
  const [selection, setSelection] = useState<{rowId:string; ids?:string[]; excerpts?:boolean; range?:{start:number;end:number}; heading?:string} | null>(null);
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
    setZoom(null);
    opener.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setAll(true);
    setLimit(12);
    setSelection({rowId:rows[index].id});
  }, [revealApp, rows, handled]);
  useEffect(() => { if (selection) detailHeading.current?.focus(); }, [selection]);
  useEffect(() => { if (zoom) resetZoom.current?.focus({preventScroll:true}); }, [zoom]);
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
  }, [hasRows, detailed]);
  if (!hasRows) return <p className="activity-empty">{historical ? '这一天没有活动记录。' : '今天还没有活动记录。开启记录或开始一次专注计时后，时间轴会出现在这里。'}</p>;

  let earliest = day.end, latest = day.begin;
  for (const row of rows) for (const entry of row.entries) {
    earliest = Math.min(earliest, entry.start);
    latest = Math.max(latest, entry.end);
  }
  const ai = rows.filter(row => row.kind === 'ai');
  const range = latest - earliest;
  const unit = range > 30 * 60_000 ? HOUR : range > 5 * 60_000 ? 5 * 60_000 : range > 90_000 ? 60_000 : range > 30_000 ? 15_000 : 5_000;
  const minimum = Math.max(20_000, unit);
  const start = zoom?.from ?? Math.min(day.end - minimum, day.begin + Math.floor((earliest - day.begin) / unit) * unit);
  const end = zoom?.to ?? Math.min(day.end, Math.max(start + minimum, day.begin + Math.ceil((latest - day.begin) / unit) * unit));
  const span = end - start;
  const percent = (at: number) => 100 * (at - start) / span;
  const time = (at: number, seconds = span <= 5 * 60_000) => at === day.end ? (seconds ? '24:00:00' : '24:00') : (seconds ? exact : clock).format(at);
  const newest = [...ai].sort((a,b) => b.entries.at(-1)!.end - a.entries.at(-1)!.end);
  const lead = [rows.find(row => row.kind === 'focus'), rows.find(row => row.kind === 'app'),
    newest.find(row => row.entries.at(-1)?.detail === aiLabels.running) ?? newest[0]].filter((row): row is Track => !!row);
  const ordered = ai.length ? [...new Set([...lead, ...rows])] : rows;
  const visibleRows = all ? ordered : ordered.slice(0, shownTracks);
  const plots = visibleRows.map(row => {
    const spans = row.entries.filter(e => e.kind !== 'observation');
    const observations = row.entries.filter(e => e.kind === 'observation');
    const ranges = observationRanges(observations);
    const instants = ranges.filter(r => r[0].start === r.at(-1)!.end);
    const windows = ranges.filter(r => r[0].start !== r.at(-1)!.end);
    return {row, spans, observations, durations:placeMarks(spans.map(e => [e]), start, span, plotWidth),
      evidence:placeMarks(windows, start, span, plotWidth), stamps:placeMarks(instants, start, span, plotWidth)};
  });
  const enlarged = plots.some(p => [...p.durations, ...p.evidence].some(g => g.marks.some(m => m.enlarged)));
  const current = rows.find(row => row.id === selection?.rowId);
  const selectedIds = selection?.ids && new Set(selection.ids);
  const details = current?.entries.filter(entry => !selectedIds || selectedIds.has(entry.id)).map(entry => {
    if (!selection?.range || entry.kind !== 'app') return entry;
    const {start,end}=selection.range;
    return {...entry,start,end,seconds:Math.min(entry.seconds,(end-start)/1000)};
  }) ?? [];
  const selectedRanges = selection?.ids ? observationRanges(details.filter(e => e.kind === 'observation')) : [];
  const selectedFrom = details.length ? Math.min(...details.map(e => e.start)) : 0;
  const selectedTo = details.length ? Math.max(...details.map(e => e.end)) : 0;
  const zoomLength = Math.max(20_000, (selectedTo - selectedFrom) * 1.5);
  const selectedChat = current?.conversation;
  const observedWindows = selectedRanges.filter(entries => entries[0].start < entries.at(-1)!.end);
  const singleSamples = selectedRanges.length > observedWindows.length;
  // Include a little context on either side of the selection. All parallel rows
  // share the magnified scale and keep their original timestamps and daily totals.
  function zoomToSelection() {
    const left = Math.max(day.begin, Math.min(day.end - zoomLength, Math.floor((selectedFrom + selectedTo - zoomLength) / 2)));
    setZoom({from:left, to:left + zoomLength});
  }
  function select(button: HTMLButtonElement, rowId: string, entries?: Entry[], excerpts = false, range?:{start:number;end:number}, heading?:string) {
    opener.current = button;
    setLimit(12);
    setSelection({rowId, excerpts, range, heading, ids:entries?.map(e => e.id)});
  }
  function close() {
    setSelection(null);
    opener.current?.focus({preventScroll:true});
  }
  return <>
    <div className="timeline-mode" role="group" aria-label="时间轴视图">
      <button type="button" aria-pressed={!detailed} onClick={()=>{setDetailed(false);setSelection(null);}}>活动总览</button>
      <button type="button" aria-pressed={detailed} onClick={()=>{setDetailed(true);setSelection(null);}}>详细轨道</button>
    </div>
    {detailed && <div className="activity-legend">
      <span><i className="activity-key-focus" />任务计时</span><span><i className="activity-key-app" />应用前台</span>
      {ai.length > 0 && <span><i className="activity-key-ai" />AI 并行活动</span>}
      {review.observations.length > 0 && <span><i className="activity-key-shot" />截图观察范围</span>}
      <span className="activity-latest-label"><i/>最近记录 <time dateTime={new Date(latest).toISOString()}>{time(latest)}</time></span>
    </div>}
    {zoom && <div className="activity-zoom"><span>局部时间轴 {time(start,true)}–{time(end,true)} · 行内时长为全天累计</span>
      <button className="activity-more" ref={resetZoom} onClick={() => { setZoom(null); detailHeading.current?.focus({preventScroll:true}); }}>返回全天</button></div>}
    {detailed ? <><div className="activity-grid">
      <span className="activity-axis-heading">时间</span>
      <div className="activity-axis" ref={ruler} aria-label="时间刻度">
        {(plotWidth < 180 ? [0,1] : plotWidth < 400 ? [0,.5,1] : [0,.25,.5,.75,1]).map(fraction => <span key={fraction} style={{left:(100 * fraction) + '%'}}>{time(start + fraction * span)}</span>)}
      </div>
      {plots.map(({row, spans:spanEntries, observations:points, durations, evidence, stamps}) => {
        const chat = row.conversation;
        const measure = measureLabels[row.kind];
        const color = row.kind === 'ai' ? '#307c70' : row.kind === 'focus' ? '#7962a7' : palette.get(row.id);
        const trackStyle = {'--activity-color':color} as CSSProperties;
        return <div className="activity-row" key={row.id} style={trackStyle}>
          <button type="button" className="activity-name" aria-label={'查看 ' + row.name + ' 的全部记录'} aria-controls={detailsId}
            onClick={e => select(e.currentTarget, row.id)}>
            <strong className={chat?.linked ? 'activity-chat-title' : undefined} title={row.name}>{row.name}</strong>
            <small className="activity-row-metrics">
              {chat?.linked && <span>{chat.turns.length} 轮 · </span>}
              {spanEntries.length > 0 && <span>{measure} {formatActivityDuration(row.seconds)}</span>}
              {row.kind === 'ai' && <span> · {row.entries.at(-1)?.detail}</span>}
              {spanEntries.length > 0 && points.length > 0 && <span className="activity-metric-divider"> · </span>}
              {points.length > 0 && <span>{points.length} 条观察</span>}
            </small>
          </button>
          <div className="activity-track" style={{'--lanes':Number(durations.length > 0) + Number(evidence.length > 0) + Number(stamps.length > 0)} as CSSProperties} role="group" aria-label={row.name + ' 时间轨道'}>
            {latest >= start && latest <= end && <span className="activity-latest-line" style={{left:percent(latest) + '%'}} aria-hidden="true"/>}
            {[...durations, ...evidence, ...stamps].map(group => {
              const {marks, left, right} = group;
              const isEvidence = marks[0].entries[0].kind === 'observation';
              const entries = marks.flatMap(m => m.entries);
              const first = Math.min(...marks.map(m => m.from)), last = Math.max(...marks.map(m => m.to));
              const stamp = first === last;
              const showSeconds = !stamp && last - first < 60_000 || span <= 5 * 60_000;
              const when = time(first,showSeconds) + (stamp ? '' : '–' + time(last,showSeconds));
              const label = row.name + ' · ' + (isEvidence ? when + ' · ' + entries.length + ' 条截图观察' :
                measure + ' ' + when + ' · ' + formatActivityDuration(entries.reduce((sum,e) => sum + e.seconds, 0))) +
                (marks.length > 1 && !stamp ? ' · ' + marks.length + ' 组' : '');
              const onlyBadges = isEvidence && marks.every(m => m.from === m.to);
              return <button type="button" className={'activity-span ' + (onlyBadges ? 'activity-badges' : isEvidence ? 'activity-evidence' : 'activity-duration')}
                key={entries[0].id} aria-label={label} title={label} aria-controls={detailsId}
                style={{'--lane':(isEvidence && durations.length ? 1 : 0) + (onlyBadges && evidence.length ? 1 : 0),
                  left:(100 * left / plotWidth) + '%', width:(100 * (right - left) / plotWidth) + '%'} as CSSProperties}
                onClick={e => select(e.currentTarget, row.id, row.kind === 'app' && !isEvidence
                  ? [...entries, ...points.filter(point => marks.some(mark => point.start >= mark.from && point.start <= mark.to))]
                  : entries)}>
                {chat?.linked ? <>
                  <i className="activity-chat-envelope" aria-hidden="true" />
                  {chat.windows.map(window => {
                    const wStart = Math.max(start,window.from), wEnd = Math.min(end,window.to);
                    if (wEnd < wStart || (wEnd === wStart && window.from !== window.to)) return null;
                    const firstVisible = Math.max(start,chat.from);
                    const visibleDuration = Math.min(end,chat.to) - firstVisible;
                    const px = visibleDuration ? Math.min(right-left,Math.max(2,(right-left)*(wEnd-wStart)/visibleDuration)) : right-left;
                    const offset = visibleDuration ? Math.max(0, Math.min(right-left-px,(right-left)*(wStart-firstVisible)/visibleDuration)) : 0;
                    return <i className="activity-chat-active" aria-hidden="true" key={window.from}
                      style={{left:100*offset/(right-left)+'%',width:100*px/(right-left)+'%'}}/>;
                  })}
                </> : onlyBadges ? <i aria-hidden="true" className="activity-stamp">{entries.length === 1 ? time(first,false) : entries.length + ' 张'}</i> :
                  marks.map(mark => <i aria-hidden="true" key={mark.entries[0].id}
                    className={isEvidence ? 'activity-observed' : undefined}
                    style={{left:(100 * (mark.left - left) / (right - left)) + '%', width:(100 * (mark.right - mark.left) / (right - left)) + '%'}} />)}
              </button>;
            })}
          </div>
          {chat?.linked && <div className="activity-chat-summary"><button type="button" className="activity-more"
            aria-expanded={selection?.rowId === row.id && !!selection.excerpts} aria-controls={detailsId}
            onClick={e => selection?.rowId === row.id && selection.excerpts ? close() : select(e.currentTarget, row.id, undefined, true)}>
            {selection?.rowId === row.id && selection.excerpts ? '收起对话摘录' : '查看对话摘录'}
          </button></div>}
          {chat?.key.endsWith(':unlinked') && <div className="activity-chat-summary">只保留了活动时间，未找到可核对的对话来源。</div>}
        </div>;
      })}
    </div>
    {enlarged && <p className="activity-scale-note">短时段已加宽显示，点选可查看准确起止时间。</p>}
    {rows.length > shownTracks && <button type="button" className="activity-more" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? '收起活动行' : '显示另外 ' + (rows.length - shownTracks) + ' 行'}</button>}
    </> : <ActivityOverview rows={rows} tasks={tasks} start={start} end={end} latest={latest} time={time} ruler={ruler} plotWidth={plotWidth}
        duration={formatActivityDuration} select={select} detailsId={detailsId}/>}
    <div id={detailsId} className={details.length ? 'activity-details' : undefined}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
      {current && details.length > 0 && <>
        <header><h3 tabIndex={-1} ref={detailHeading}>{selection?.heading ?? current.name} · {selectedChat?.linked ? selectedChat.turns.length + ' 轮对话' : details.length + ' 条记录'}</h3>
          <button type="button" className="activity-more" onClick={close}>收起明细</button></header>
        {selection?.ids && !zoom && zoomLength < span && <button type="button" className="activity-more"
          onClick={zoomToSelection}>放大这个时段</button>}
        {observedWindows.slice(0,limit).map(entries => <p className="activity-range-note" key={entries[0].id}>
          观察范围 {time(entries[0].start,true)}–{time(entries.at(-1)!.end,true)} · {entries.length} 张截图，仅表示首次至末次观察
        </p>)}
        {singleSamples && <p className="activity-range-note">单次截图仅有采样时刻，持续时间未知。</p>}
        {selectedChat?.linked ? <>
          <p className="activity-range-note">对话跨度 {time(selectedChat.from,true)}–{time(selectedChat.to,true)} · 实际 AI 活动 {formatActivityDuration(selectedChat.activeSeconds)}。浅色连接同一对话，深色表示观察到的活动。小结依据当天可读的提问与公开答复摘录。</p>
          {selection?.excerpts && review.aiConversationSummaries?.[selectedChat.key] && <p className="activity-chat-excerpt"><b>对话小结</b>{review.aiConversationSummaries[selectedChat.key]}</p>}
          <ol>{selectedChat.turns.slice(0,limit).map((turn,index) => <li key={turn.id}>
            <time dateTime={new Date(turn.from).toISOString()}>{time(turn.from,true)}–{time(turn.to,true)}</time>
            <div><strong>第 {index + 1} 轮 · {aiLabels[turn.state]}</strong>
              {selection?.excerpts && turn.userExcerpt && <p className="activity-chat-excerpt"><b>你</b>{turn.userExcerpt}</p>}
              {selection?.excerpts && turn.assistantExcerpt && <p className="activity-chat-excerpt"><b>AI</b>{turn.assistantExcerpt}</p>}
              {selection?.excerpts && !turn.userExcerpt && !turn.assistantExcerpt && <small>暂无可读的消息摘录</small>}
            </div>
          </li>)}</ol>
        </> : <ol>{details.slice(0,limit).map(entry => {
          const task = entry.taskId && tasks?.find(t => t.id === entry.taskId);
          const fine = entry.end > entry.start && entry.end - entry.start < 1000;
          return <li key={entry.id}><time dateTime={new Date(entry.start).toISOString()}>{fine ? subsecond.format(entry.start) : time(entry.start,true)}
            {entry.kind !== 'observation' && '–' + (fine ? subsecond.format(entry.end) : time(entry.end,true))}</time>
            <div>{entry.kind !== 'observation' && <strong>{measureLabels[entry.kind] + ' '}{formatActivityDuration(entry.seconds)} · </strong>}
              {entry.detail}{entry.kind === 'observation' && <small>{entry.source}{task ? ' · ' + task.title : ''}</small>}</div>
          </li>;
        })}</ol>}
        {(selectedChat?.linked ? selectedChat.turns.length : details.length) > limit && <button type="button" className="activity-more" onClick={() => setLimit(limit + 24)}>显示更多明细</button>}
      </>}
    </div>
  </>;
}

export default function ActivityTimeline({review, tasks, revealApp, error, onRetry, historical, recorder}: Props) {
  const heading = useId();
  const handled = useRef<Props['revealApp']>(null);
  const state = recorder?.status?.state;
  const recording = state === 'recording' || state === 'starting' || state === 'stopping';
  const aiOnly = recording && recorder?.status?.mode === 'ai';
  return <section className="activity-timeline" aria-labelledby={heading}>
    <header className="activity-header"><h2 id={heading}>{historical ? '当日活动时间轴' : '今日活动时间轴'}</h2>
      {review && <span><time dateTime={review.date}>{review.date}</time> · {review.timezone}</span>}
    </header>
    {error && <p role="alert" className="activity-error">活动记录读取失败。{error} {onRetry &&
      <button type="button" className="activity-more" onClick={onRetry}>重试</button>}</p>}
    {review?.aiUnavailable && <p className="activity-error" role="status">AI 活动记录暂时无法读取。</p>}
    {review ? <Chart key={review.date + review.timezone} review={review} historical={historical} tasks={tasks} revealApp={revealApp} handled={handled}/> :
      !error && <p className="activity-empty" role="status">正在读取今日活动…</p>}
    {recorder?.status && (!recording || aiOnly) && <button type="button" className="activity-more ai-only-button"
      disabled={!!recorder.pending || !!recorder.readError || state === 'stopping'}
      onClick={() => void recorder.change(aiOnly ? 'stop' : 'start-ai')}>{aiOnly ? '停止 AI 状态记录' : '仅记录 AI 状态'}</button>}
    {!historical && <details className="activity-setup"><summary>如何记录并行的 AI 活动</summary>
      <p>「开始记录」会记录前台画面和 AI 状态。「仅记录 AI 状态」只读取轮次和生成信号，整个过程不截图。总览按应用显示，详细轨道可逐个查看对话。对话主题和本机小结会随记录更新。</p>
      <p>ChatGPT 网页可通过 Chrome 或 Edge 扩展接入。<a href="/focusdesk-chatgpt.zip" download>下载扩展</a>，解压后在浏览器的扩展管理页打开开发者模式，选择「加载已解压的扩展程序」，再刷新 ChatGPT 标签页。Hub 使用自定义端口时，可在扩展选项中填写。</p>
      <p>扩展在记录期间读取当前对话的主题和简短消息摘录。本机模型据此生成小结；标签休眠或断连时，活动停在最后一次确认处。</p>
    </details>}
  </section>;
}
