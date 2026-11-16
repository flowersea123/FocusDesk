import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEntry, CalendarSnapshot } from '../../contracts/calendar';
import './task-calendar.css';

const endpoint = '/api/v1/calendar';
const dayMs = 86_400_000;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const statusLabels = { scheduled: '已安排', waiting: '等待今日清单腾出位置', published: '已加入今日任务', done: '已完成', removed: '已移除' };
const sourceLabels = { mail: '邮件', canvas: 'Canvas', manual: '手动安排' };
const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const monthLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'UTC' });
const dateOf = (value: string) => new Date(value + 'T00:00:00Z');
const dayOf = (value: Date | number) => {
  const iso = new Date(value).toISOString();
  return iso.startsWith('+') || iso.startsWith('-') || iso.startsWith('0000') ? '' : iso.slice(0, 10);
};
export function validDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000') && Number.isFinite(+dateOf(value)) && dayOf(dateOf(value)) === value;
}
function monthDays(day: string) {
  const start = dateOf(day.slice(0, 7) + '-01');
  const first = +start - ((start.getUTCDay() + 6) % 7) * dayMs;
  start.setUTCMonth(start.getUTCMonth() + 1);
  return Array.from({ length: Math.ceil((+start - first) / dayMs / 7) * 7 }, (_, i) => dayOf(first + i * dayMs));
}
function adjacentMonth(day: string, step: number) {
  const date = dateOf(day.slice(0, 7) + '-01');
  date.setUTCMonth(date.getUTCMonth() + step + 1, 0);
  date.setUTCDate(Math.min(date.getUTCDate(), Number(day.slice(-2))));
  return dayOf(date);
}
function deadline(entry: CalendarEntry, timezone: string) {
  if (entry.dueAt) return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(entry.dueAt));
  return entry.dueDate ? fullDate.format(dateOf(entry.dueDate)) : '未指定';
}

interface Props { active: boolean; date: string; onDate: (day: string) => void; onChange: () => void }
export default function TaskCalendar({ active, date, onDate, onChange }: Props) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<{ entry: CalendarEntry; revision: string; day: string; remove: boolean } | null>(null);
  const request = useRef(0);
  const busy = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    const current = ++request.current;
    try {
      const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const data: CalendarSnapshot = await response.json();
      if (current === request.current) { setSnapshot(data); setReadError(''); }
    } catch {
      if (current === request.current) setReadError('暂时无法读取任务日历。');
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { ++request.current; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [active, refresh]);
  const selected = date || snapshot?.today || '';
  const dates = useMemo(() => selected ? monthDays(selected) : [], [selected]);
  const byDate = useMemo(() => {
    const days = new Map<string, CalendarEntry[]>();
    for (const entry of snapshot?.entries ?? []) {
      if (entry.status === 'removed') continue;
      if (!days.has(entry.plannedDate)) days.set(entry.plannedDate, []);
      days.get(entry.plannedDate)!.push(entry);
    }
    return days;
  }, [snapshot]);
  const entries = byDate.get(selected) ?? [];
  function choose(day: string, keyboard = false) {
    if (busy.current || !validDay(day)) return;
    onDate(day); setEdit(null); setError(''); setNotice('');
    if (keyboard) requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>('[data-date="' + day + '"]')?.focus());
  }
  async function save() {
    if (!edit || busy.current || (!edit.remove && !validDay(edit.day))) return;
    busy.current = true; ++request.current; setSaving(true); setError(''); setNotice('');
    const { status: _status, ...item } = edit.entry;
    try {
      const body = edit.remove ? { revision: edit.revision, id: item.id } :
        { revision: edit.revision, entry: { ...item, plannedDate: edit.day } };
      const response = await fetch(endpoint, { method: edit.remove ? 'DELETE' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) setEdit(null);
        throw new Error(data.error || '保存失败，请重试。');
      }
      setSnapshot(data); setEdit(null); setReadError('');
      if (!edit.remove) onDate(edit.day);
      setNotice(edit.remove ? '已移除这项安排。' : '计划日期已更新。');
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    } finally {
      busy.current = false; setSaving(false); void refresh();
    }
  }
  return <section className="task-calendar" aria-labelledby="calendar-title">
    <header className="desk-masthead"><div><h1 id="calendar-title">任务日历</h1>
      <p className="desk-date">按计划日期安排待办，到日后同步至今日任务和电子屏。</p></div>
      <a className="calendar-mail" href={import.meta.env.VITE_MAIL_PAGE_URL} target="_blank" rel="noreferrer">从邮件安排 ↗</a>
    </header>
    {readError && <p role="alert">{readError} <button onClick={refresh}>重试</button></p>}
    {!snapshot && !readError && <p role="status">正在读取日历…</p>}
    {snapshot && selected && <div className="calendar-layout">
      <section className="calendar-month" aria-label="按月查看">
        <div className="calendar-toolbar"><h2>{monthLabel.format(dateOf(selected))}</h2><div>
          <button type="button" aria-label="上个月" disabled={saving || !adjacentMonth(selected,-1)} onClick={() => choose(adjacentMonth(selected,-1))}>‹</button>
          <button type="button" disabled={saving} onClick={() => choose(snapshot.today)}>今天</button>
          <button type="button" aria-label="下个月" disabled={saving || !adjacentMonth(selected,1)} onClick={() => choose(adjacentMonth(selected,1))}>›</button>
        </div></div>
        <div className="calendar-week" aria-hidden="true">{weekdays.map(label => <span key={label}>{label}</span>)}</div>
        <div className="calendar-days" ref={grid} role="group" aria-label="选择计划日期">{dates.map((day, index) => {
          if (!day) return <span aria-hidden="true" key={'outside-' + index}/>;
          const items = byDate.get(day) ?? [];
          return <button type="button" key={day} data-date={day} aria-label={fullDate.format(dateOf(day)) + '，' + items.length + ' 项待办'}
            aria-pressed={selected === day} aria-current={day === snapshot.today ? 'date' : undefined}
            data-adjacent={day.slice(0,7) !== selected.slice(0,7)} tabIndex={selected === day ? 0 : -1} disabled={saving}
            onClick={() => choose(day)} onKeyDown={event => {
              const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
              if (delta) { event.preventDefault(); choose(dayOf(+dateOf(day) + delta * dayMs), true); }
            }}><span>{Number(day.slice(-2))}</span>{items.length > 0 && <>
              <small className="calendar-count">{items.length} 项</small>
              <span className="calendar-first" aria-hidden="true" title={items[0].title}>{items[0].title}</span>
            </>}</button>;
        })}</div>
      </section>
      <section className="calendar-agenda" aria-label="当日安排"><header><h2>{fullDate.format(dateOf(selected))}</h2>
        <span>{entries.length} 项待办</span></header>
        {!entries.length && <p className="calendar-empty">这一天还没有安排。</p>}
        <ul>{entries.map(entry => <li key={entry.id}>
          <div className="calendar-source"><span>{sourceLabels[entry.source]}</span><span>{statusLabels[entry.status]}</span></div>
          <h3>{entry.title}</h3><dl>
            <dt>原定截止</dt><dd>{deadline(entry, snapshot.timezone)}</dd>
            <dt>屏幕标题</dt><dd lang="en">{entry.deviceTitle}</dd>
            {entry.sourceTitle && entry.sourceTitle !== entry.title && <><dt>来源标题</dt><dd>{entry.sourceTitle}</dd></>}
          </dl>
          {edit?.entry.id === entry.id ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
            {edit.remove ? <p>从日历移除这项待办？</p> : <label>新的计划日期<input autoFocus type="date" required value={edit.day} disabled={saving}
              onChange={event => setEdit({ ...edit, day: event.target.value })}/></label>}
            <button type="submit" disabled={saving || (!edit.remove && !validDay(edit.day))}>{edit.remove ? '确认移除' : '保存日期'}</button>
            <button type="button" disabled={saving} onClick={() => setEdit(null)}>取消</button></form> :
            entry.status !== 'done' && <div className="calendar-actions">{['改期','移除'].map((label,i) =>
              <button type="button" key={label} disabled={saving} onClick={() => { setNotice(''); setError('');
                setEdit({ entry, revision: snapshot.revision, day: entry.plannedDate, remove: i === 1 }); }}>{label}</button>)}</div>}
        </li>)}</ul>
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      </section>
    </div>}
  </section>;
}
