import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FocusSession } from '../../../contracts/daily-overview';
import { summarizeReview, type FocusReview } from '../../../contracts/focus-review';

export function useFocusReview({ date = '', refreshKey, active = true, focus }: {
  date?: string; refreshKey?: string | number; active?: boolean; focus?: FocusSession | null;
}) {
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ query: string; readAt: number; review: FocusReview } | null>(null);
  const [issue, setIssue] = useState<{ query: string; text: string } | null>(null);
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let reading = false;
    async function read() {
      if (reading || controller.signal.aborted || document.hidden) return;
      reading = true;
      try {
        const response = await fetch('/api/v1/focus-review' + (date ? '?date=' + encodeURIComponent(date) : ''), {
          credentials: 'same-origin', cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '暂时无法读取活动记录。');
        if (!Array.isArray(data.sessions) || !Array.isArray(data.observations) || !data.timezone ||
          data.date !== (date || data.today)) throw new Error('本机返回的活动记录不完整。');
        if (!controller.signal.aborted) { setSnapshot({ query: date, readAt: Date.now(), review: data }); setIssue(null); }
      } catch (error) {
        if (!controller.signal.aborted) setIssue({ query: date, text: error instanceof Error ? error.message : '暂时无法读取活动记录。' });
      } finally { reading = false; }
    }
    void read();
    const timer = window.setInterval(read, 15_000);
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      controller.abort(); window.clearInterval(timer);
      window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read);
    };
  }, [date, active, refreshKey, version]);
  let review = snapshot?.query === date ? snapshot.review : null;
  const timezone = review?.timezone;
  const day = useMemo(() => timezone ? new Intl.DateTimeFormat('en-CA', {timeZone:timezone}) : null, [timezone]);
  if (!date && review && snapshot && day) {
    if (day.format(snapshot.readAt) !== day.format(Date.now())) review = null;
  }
  const running = review?.date === review?.today ? review?.sessions.at(-1) : null;
  const live = !!(active && !issue && focus && running?.end === 'running' && running.taskId === focus.task_id &&
    Date.parse(running.from) >= Date.parse(focus.started_at) && Date.parse(running.to) <= Date.parse(focus.ends_at));
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const tick = () => { if (!document.hidden) setClock(Date.now()); };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const endsAt = focus?.ends_at;
  const displayed = useMemo(() => {
    if (!review || !live || !running || !endsAt || !snapshot) return review;
    const last = Date.parse(running.to);
    // Only bridge the next normal refresh. A disconnected client cannot confirm time indefinitely.
    const to = Math.min(Date.parse(endsAt), last + Math.max(0, Math.min(20_000, clock - snapshot.readAt)));
    if (to <= last) return review;
    const seconds = Math.floor((to - Date.parse(running.from)) / 1000);
    const sessions = [...review.sessions.slice(0, -1), {...running, seconds, to:new Date(to).toISOString()}];
    const totalSeconds = review.totalSeconds + seconds - running.seconds;
    return {...review, sessions, totalSeconds, ...summarizeReview(sessions,totalSeconds,review.observations,review.appSessions ?? [])};
  }, [review, live, running, endsAt, snapshot, clock]);
  return { review:displayed, error: issue?.query === date ? issue.text : '', refresh };
}
