import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AiRunObservation } from './ai-activity-types.ts';

const freshMs = 60_000;
const maxBatch = 256;
const sessionGap = 30_000;

interface Turn {
  status: string;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
}
interface Identity { thread_id: string; turn_id: string }
interface Tracked extends Identity {
  ordinal: number; evidenceAt: number; visible: boolean;
}

function openQueries(db: DatabaseSync) {
  // SQLite's rowid and the existing (thread_id, turn_id, updated_at_ordinal) index
  // keep polling independent of the history file size. Never select item_json.
  db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-256; PRAGMA busy_timeout=25');
  const ids = 'rowid AS cursor,thread_id,turn_id';
  const queries = (table: string) => ({
    tail: db.prepare('SELECT ' + ids + ' FROM ' + table + ' ORDER BY rowid DESC LIMIT ?'),
    since: db.prepare('SELECT ' + ids + ' FROM ' + table + ' WHERE rowid>? ORDER BY rowid LIMIT ?'),
  });
  return {
    turns: queries('thread_turns'), items: queries('thread_items'),
    state: db.prepare('SELECT status,started_at,completed_at,duration_ms FROM thread_turns WHERE thread_id=? AND turn_id=?'),
    item: db.prepare('SELECT created_at_ms,updated_at_ordinal FROM thread_items INDEXED BY idx_thread_items_by_turn_updated_page WHERE thread_id=? AND turn_id=? ORDER BY updated_at_ordinal DESC LIMIT 1'),
  };
}

function idFor({ thread_id, turn_id }: Identity) {
  return 'codex-' + createHash('sha256').update(thread_id).update('\0').update(turn_id).digest('hex').slice(0, 24);
}
function observe(runId: string, at: number, state: AiRunObservation['state']): AiRunObservation {
  return { runId, appName: 'Codex', title: '轮次 ' + runId.slice(-6), at, state };
}
function stamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function createCodexActivitySource({ databasePath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'thread_history_1.sqlite'),
  now = Date.now }: { databasePath?: string; now?: () => number } = {}) {
  let db: DatabaseSync | undefined, query: ReturnType<typeof openQueries> | undefined, fileKey = '';
  let turnCursor = 0, itemCursor = 0, lastPoll: number | undefined, since = 0;
  let closed = false;
  const tracked = new Map<string, Tracked>();
  const delivered = new Set<string>();
  function reset() {
    db?.close();
    db = undefined;
    query = undefined;
    fileKey = '';
    turnCursor = itemCursor = 0;
    lastPoll = undefined;
    tracked.clear();
    delivered.clear();
  }

  type Rows = { tail: StatementSync; since: StatementSync };
  function discover(rows: Rows, first: boolean, cursor: number, accept: (value: Identity) => void) {
    const result = first ? rows.tail.all(maxBatch) : rows.since.all(cursor, maxBatch);
    for (const row of result) {
      if (typeof row.thread_id === 'string' && typeof row.turn_id === 'string') {
        accept({thread_id:row.thread_id, turn_id:row.turn_id});
      }
      cursor = Math.max(cursor, Number(row.cursor));
    }
    return cursor;
  }

  return {
    async poll(signal: AbortSignal): Promise<AiRunObservation[]> {
      if (closed || signal.aborted) return [];
      try {
        const info = await stat(databasePath);
        if (closed || signal.aborted) return [];
        const key = [info.dev, info.ino, info.birthtimeMs].join('/');
        if (!info.isFile()) { reset(); return []; }
        if (key !== fileKey) {
          reset();
          // Lazy loading keeps unrelated Hub requests and installs without a store independent of SQLite.
          const { DatabaseSync } = await import('node:sqlite');
          if (closed || signal.aborted) return [];
          db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
          query = openQueries(db); fileKey = key;
        }
        const clock = now();
        if (lastPoll !== undefined && (clock < lastPoll || clock - lastPoll > sessionGap)) {
          tracked.clear(); delivered.clear(); lastPoll = undefined;
        }
        const first = lastPoll === undefined;
        if (first) since = clock;
        const candidates = new Map<string, Identity>(tracked);
        const discoveredTurns = new Set<string>();
        const output: AiRunObservation[] = [];
        db!.exec('BEGIN');
        turnCursor = discover(query!.turns, first, turnCursor, identity => {
          const id = idFor(identity); candidates.set(id, identity); discoveredTurns.add(id);
        });
        itemCursor = discover(query!.items, first, itemCursor, identity => candidates.set(idFor(identity), identity));
        for (const [id, identity] of candidates) {
          if (delivered.has(id)) continue;
          const args = [identity.thread_id, identity.turn_id];
          const turn = query!.state.get(...args) as Turn | undefined;
          const previous = tracked.get(id);
          const start = stamp(turn?.started_at) * 1000;
          if (!turn || !start || start > clock) { tracked.delete(id); continue; }
          if (turn.status !== 'inProgress') {
            tracked.delete(id);
            const end = stamp(turn.completed_at) * 1000;
            if (first || !end || end + 1000 <= since || !['completed', 'interrupted', 'failed'].includes(turn.status)) continue;
            // Timestamps are rounded to seconds. For short turns, retain the recorded duration
            // and pick the earliest bounds compatible with both reported seconds.
            const duration = stamp(turn.duration_ms);
            const useDuration = duration > 0 && Math.abs(end - start - duration) < 1000;
            const firstAt = useDuration ? Math.max(start, end - duration) : start;
            const lastAt = useDuration ? firstAt + duration : end;
            if (!previous?.visible) {
              // A complete new turn can start and finish between two reads.
              if (previous || !discoveredTurns.has(id) || start < Math.floor(since / 1000) * 1000) continue;
              output.push(observe(id, Math.min(clock, Math.max(since, firstAt)), 'running'));
            }
            output.push(observe(id, Math.min(clock, Math.max(since, start, lastAt)), turn.status === 'completed' ? 'finished' : 'interrupted'));
            delivered.add(id);
            if (delivered.size > maxBatch * 2) delivered.delete(delivered.values().next().value!);
            continue;
          }

          const item = query!.item.get(...args);
          const ordinal = Number(item?.updated_at_ordinal ?? -1);
          const itemAt = stamp(item?.created_at_ms);
          let evidence = Math.max(previous?.evidenceAt ?? 0, start, itemAt <= clock ? itemAt : 0);
          // An in-place item update (including a streaming/tool update) can advance its
          // ordinal while keeping the original creation time.
          if (previous && ordinal > previous.ordinal) evidence = clock;
          if (clock - evidence > freshMs) {
            if (previous?.visible) output.push(observe(id, Math.max(since, evidence), 'interrupted'));
            // Keep recently observed silent turns addressable in case an existing item changes in place.
            if (previous && clock - evidence < freshMs * 5) tracked.set(id, { ...identity, ordinal, evidenceAt:evidence, visible:false });
            else tracked.delete(id);
            continue;
          }
          const beginning = previous ? clock : Math.max(lastPoll ?? since, discoveredTurns.has(id) ? start : evidence);
          if (!previous?.visible && beginning < clock) output.push(observe(id, beginning, 'running'));
          output.push(observe(id, clock, 'running'));
          tracked.set(id, { ...identity, ordinal, evidenceAt:evidence, visible:true });
        }
        db!.exec('COMMIT');
        lastPoll = clock;
        return output.sort((a, b) => a.at - b.at);
      } catch {
        // Missing/locked/incompatible stores lose continuity. Other AI sources continue.
        reset();
        return [];
      }
    },
    close() { closed = true; reset(); },
  };
}
