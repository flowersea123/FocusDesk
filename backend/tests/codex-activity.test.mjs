import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCodexActivitySource } from '../src/codex-activity.ts';

const epoch = Date.UTC(2026, 10, 16, 12);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'focusdesk-codex-'));
  const path = join(dir, 'history.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER,
      duration_ms INTEGER, PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,created_at_ms INTEGER,updated_at_ordinal INTEGER);
    CREATE INDEX idx_thread_items_by_turn_updated_page ON thread_items(thread_id,turn_id,updated_at_ordinal);
  `);
  let clock = epoch;
  const source = createCodexActivitySource({ databasePath:path, now:() => clock });
  const signal = new AbortController().signal;
  t.after(async () => { source.close(); db.close(); await rm(dir,{recursive:true,force:true}); });
  const second = delta => Math.floor((epoch + delta) / 1000);
  return { db,path,source,signal,
    turn(id, delta, thread = 'private-thread-name') {
      db.prepare('INSERT INTO thread_turns VALUES (?,?,?, ?,NULL,NULL)').run(thread,id,'inProgress',second(delta));
    },
    end(id, delta, status = 'completed', duration = null) {
      db.prepare('UPDATE thread_turns SET status=?,completed_at=?,duration_ms=? WHERE turn_id=?').run(status,second(delta),duration,id);
    },
    item(id, delta, ordinal) {
      db.prepare('INSERT INTO thread_items VALUES (?,?,?,?)').run('private-thread-name',id,epoch+delta,ordinal);
    },
    async poll(delta) { clock = epoch + delta; return source.poll(signal); },
  };
}

test('clips recent mid-turn activity to recording start, omits old inert rows, and polls only lifecycle metadata', async t => {
  const f = await fixture(t);
  f.turn('long-running', -300_000);
  f.item('long-running',-4000,1);
  f.turn('new-turn',-1000);
  f.turn('stale',-700_000);
  f.turn('already-done',-5000); f.end('already-done',-1000);
  const before = await stat(f.path);
  const rows = await f.poll(0);
  assert.equal(rows.length,2);
  assert.ok(rows.every(row => row.appName === 'Codex' && row.state === 'running' && row.at === epoch));
  assert.ok(rows.every(row => /^codex-[0-9a-f]{24}$/.test(row.runId)));
  assert.equal(new Set(rows.map(row => row.title)).size,2);
  assert.doesNotMatch(JSON.stringify(rows), /private-thread-name|long-running|new-turn|stale|already-done/);
  f.end('new-turn',1000,'failed');
  const after = await f.poll(4000);
  assert.deepEqual(after.map(row => [row.state,row.at]),[['interrupted',epoch+1000],['running',epoch+4000]]);
  const afterFile = await stat(f.path);
  await f.poll(6000);
  assert.equal((await stat(f.path)).mtimeMs,afterFile.mtimeMs);
  assert.equal((await stat(f.path)).size,before.size);
});

test('emits start and finish when a short turn completed between two polls, and never replays it', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.poll(0),[]);
  f.turn('short',1100); f.end('short',1600,'completed',500);
  f.turn('parallel',1000,'second-private-thread'); f.end('parallel',3000,'interrupted');
  const rows = await f.poll(4000);
  const byRun = Map.groupBy(rows,row => row.runId);
  assert.equal(byRun.size,2);
  const completed = [...byRun.values()].find(events => events.at(-1).state === 'finished');
  assert.equal(completed[1].at-completed[0].at,500);
  assert.deepEqual(completed.map(row => row.state),['running','finished']);
  assert.ok(rows.every(row => row.at >= epoch + 1000 && row.at <= epoch + 3000));
  f.item('short',4200,7);
  assert.deepEqual(await f.poll(6000),[]);
});

test('a stalled projected task times out at the last real evidence, and an in-place item update reopens it', async t => {
  const f = await fixture(t);
  f.turn('silent',0); f.item('silent',0,1);
  await f.poll(0);
  for (const time of [15_000,30_000,45_000,60_000]) assert.equal((await f.poll(time))[0].state,'running');
  const interrupted = await f.poll(65_000);
  assert.deepEqual(interrupted.map(event=>[event.state,event.at]),[['interrupted',epoch]]);
  assert.deepEqual(await f.poll(68_000),[]);
  f.db.exec('UPDATE thread_items SET updated_at_ordinal=2');
  const reopened = await f.poll(70_000);
  assert.equal(reopened.length,1);
  assert.equal(reopened[0].state,'running'); assert.equal(reopened[0].at,epoch+70_000);
  assert.equal(reopened[0].runId,interrupted[0].runId);
  f.end('silent',73_000);
  assert.deepEqual((await f.poll(75_000)).map(event=>event.state),['finished']);
});

test('a long sampling gap never backfills work during sleep and cold completed turns stay out', async t => {
  const f = await fixture(t);
  f.turn('old',0); await f.poll(0);
  f.end('old',120_000);
  f.turn('still-running',40_000); f.item('still-running',148_000,4);
  const rows = await f.poll(150_000);
  assert.deepEqual(rows.map(row => [row.state,row.at]),[['running',epoch+150_000]]);
});

test('new event metadata discovers an active old turn outside the initial row window; absent/incompatible stores degrade', async t => {
  const f = await fixture(t);
  f.turn('long',-400_000);
  for (let i=0; i<300; i++) { f.turn('old'+i,-200_000); f.end('old'+i,-100_000); }
  assert.deepEqual(await f.poll(0),[]);
  f.item('long',1500,1);
  assert.deepEqual((await f.poll(3000)).map(row => [row.state,row.at]),[['running',epoch+1500],['running',epoch+3000]]);
  f.db.exec('DROP TABLE thread_items');
  assert.deepEqual(await f.poll(4000),[]);
  const file = join(tmpdir(),'nonexistent-' + crypto.randomUUID() + '.sqlite');
  const missing = createCodexActivitySource({databasePath:file});
  assert.deepEqual(await missing.poll(f.signal),[]);
  await assert.rejects(stat(file), {code:'ENOENT'});
  missing.close();
  assert.deepEqual(await missing.poll(f.signal),[]);
});
