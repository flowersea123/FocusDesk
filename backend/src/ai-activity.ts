import { setTimeout as delay } from 'node:timers/promises';
import type { AiSession } from '../../contracts/focus-review.ts';
import type { AiActivitySource, AiRunObservation } from './ai-activity-types.ts';

const RETENTION_MS = 90 * 86_400_000;
const MAX_SPANS = 4096;
const MAX_GAP_MS = 30_000;
const FLUSH_MS = 60_000;
type Span = Omit<AiSession, 'from' | 'to'> & { from: number; to: number };
type Journal = { version: 1; spans: Span[] };

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 8.64e15;
}

function label(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u.test(value);
}

function validIdentity(row: Partial<Span>) {
  return typeof row.runId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.runId) &&
    label(row.appName, 60) && label(row.title, 120) &&
    (row.state === 'running' || row.state === 'finished' || row.state === 'interrupted');
}

const keyOf = (row: Pick<Span, 'appName' | 'runId'>) => row.appName + '\0' + row.runId;

/** Private run metadata only. History and live spans are serialized through the same queue. */
export function createAiActivityJournal(io: {
  read(): Promise<unknown>;
  write(data: Journal): Promise<void>;
}) {
  let spans: Span[] | undefined;
  let queue = Promise.resolve();
  let lastSavedAt = -Infinity;
  let dirty = false;

  async function load(): Promise<Span[]> {
    if (spans) return spans;
    let record: Journal;
    try { record = await io.read() as Journal; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return spans = [];
    }
    if (record?.version !== 1 || !Array.isArray(record.spans) || record.spans.length > MAX_SPANS ||
        !record.spans.every(s => s && validIdentity(s) && timestamp(s.from) && timestamp(s.to) && s.from <= s.to)) {
      throw new Error('AI 活动记录格式无效。');
    }
    // No process restart can attest to an unfinished run after the last persisted heartbeat.
    return spans = record.spans.map(({ runId, appName, title, from, to, state }) => ({
      runId, appName, title, from, to, state: state === 'running' ? 'interrupted' : state,
    }));
  }

  function serialized<T>(job: (current: Span[]) => Promise<T> | T): Promise<T> {
    const result = queue.then(async () => job(await load()));
    queue = result.then(() => {}, () => {});
    return result;
  }

  return {
    async read(begin: number, end: number, now: number): Promise<AiSession[]> {
      return serialized(current => current.flatMap(s => {
        const from = Math.max(begin, now - RETENTION_MS, s.from);
        const to = Math.min(end, now, s.to);
        if (to < from || (to === from && (s.from !== from || from >= end))) return [];
        // Preserve a just-started point. A run is never extended to the time at which a page is opened.
        const state = s.state === 'running' && now - s.to > MAX_GAP_MS ? 'interrupted' : s.state;
        return [{ ...s, state, from: new Date(from).toISOString(), to: new Date(to).toISOString() }];
      }).sort((a,b) => a.from.localeCompare(b.from) || a.runId.localeCompare(b.runId)));
    },

    record(observations: readonly AiRunObservation[], since: number, at: number, discontinuity = false) {
      return serialized(async current => {
        if (!timestamp(at) || !timestamp(since) || since > at) return;
        const floor = at - RETENTION_MS;
        const expired = current.some(row => row.to < floor);
        if (!observations.length && !expired && !dirty && !current.some(row => row.state === 'running')) return;
        const active = new Map<string, number>();
        const latest = new Map<string, Span>();
        const rows = current.slice();
        let boundary = expired;
        let changed = false;
        const discarded = new Set<number>();
        for (let i = 0; i < rows.length; i++) {
          const s = rows[i];
          latest.set(keyOf(s), s);
          if (s.state !== 'running') continue;
          if (discontinuity) {
            rows[i] = { ...s, state: 'interrupted' };
            latest.set(keyOf(s), rows[i]);
            boundary = true;
          } else active.set(keyOf(s), i);
        }
        const seen = new Set<string>();
        const events = observations.filter(e => e && validIdentity(e) && timestamp(e.at) && e.at <= at)
          .sort((a,b) => a.at - b.at || Number(a.state !== 'running') - Number(b.state !== 'running'));
        for (const event of events) {
          const key = keyOf(event);
          let index = active.get(key);
          if (index !== undefined && event.at - rows[index].to > MAX_GAP_MS) {
            rows[index] = { ...rows[index], state: 'interrupted' };
            latest.set(key, rows[index]);
            active.delete(key);
            index = undefined;
            boundary = true;
          }
          if (index === undefined) {
            // A lone finish or late replay never recreates an unobserved start.
            const previous = latest.get(key);
            if (event.state !== 'running' || event.at < since || previous?.state === 'finished' ||
                (previous && event.at < previous.to)) continue;
            const row: Span = { runId: event.runId, appName: event.appName, title: event.title, from: event.at, to: event.at, state: 'running' };
            active.set(key, rows.length);
            latest.set(key, row);
            rows.push(row);
            seen.add(key);
            boundary = true;
            continue;
          }

          const row = rows[index];
          if (event.state === 'running') {
            seen.add(key);
            if (event.at > row.to) {
              rows[index] = { ...row, to: event.at };
              changed = true;
            }
          } else {
            // An authoritative end can arrive after a provisional heartbeat with an earlier timestamp.
            if (event.at < row.from) discarded.add(index);
            rows[index] = { ...row, to: event.at, state: event.state };
            latest.set(key, rows[index]);
            active.delete(key);
            boundary = true;
          }
        }
        for (const [key, index] of active) {
          if (!seen.has(key) || at - rows[index].to > MAX_GAP_MS) {
            rows[index] = { ...rows[index], state: 'interrupted' };
            boundary = true;
          }
        }
        if (changed || boundary) {
          // Retain active spans even when many older short tasks churn through the history.
          const retained = rows.filter((s, i) => !discarded.has(i) && s.to >= floor);
          if (retained.length > MAX_SPANS) {
            const live = retained.filter(s => s.state === 'running').slice(-MAX_SPANS);
            const available = MAX_SPANS - live.length;
            spans = [...(available ? retained.filter(s => s.state !== 'running').slice(-available) : []), ...live];
          } else spans = retained;
          dirty = true;
        }
        if (dirty && (boundary || discontinuity || at - lastSavedAt >= FLUSH_MS)) {
          await io.write({ version: 1, spans: spans! });
          dirty = false;
          lastSavedAt = at;
        }
      });
    },
  };
}

export async function monitorAiActivity(
  source: AiActivitySource, journal: ReturnType<typeof createAiActivityJournal>, signal: AbortSignal,
  now = Date.now, pollMs = 4_000,
) {
  let previous = now();
  try {
    while (!signal.aborted) {
      let observations: AiRunObservation[] = [];
      try { observations = await source.poll(signal); } catch { /* Loss of evidence closes previously observed activity. */ }
      if (signal.aborted) break;
      const at = now();
      const gap = at < previous || at - previous > MAX_GAP_MS;
      await journal.record(observations, gap ? at : previous, at, gap);
      previous = at;
      await delay(pollMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    try { await source.close?.(); }
    finally { const at = now(); await journal.record([], at, at, true); }
  }
}
