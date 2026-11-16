import { useCallback, useEffect, useState } from 'react';
import type { FocusReview } from '../../../contracts/focus-review';

export function useFocusReview({ date = '', refreshKey, active = true }: {
  date?: string; refreshKey?: string | number; active?: boolean;
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
  if (!date && review && snapshot) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: review.timezone });
    if (day.format(snapshot.readAt) !== day.format(Date.now())) review = null;
  }
  return { review, error: issue?.query === date ? issue.text : '', refresh };
}
