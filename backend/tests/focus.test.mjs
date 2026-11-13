import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoServer } from '../src/service.ts';
import { createOverviewLoader } from '../src/overview-loader.ts';
import { parseDailyOverviewText, FOCUS_DURATION_MS } from '../../contracts/daily-overview.ts';

const fixture = JSON.parse(await readFile(new URL('../../contracts/fixtures/device-demo.json', import.meta.url), 'utf8'));
const seed = { date: fixture.date, timezone: fixture.timezone, tasks: fixture.tasks };
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-focus-'));
  const dataPath = path.join(directory, 'tasks.json');
  await writeFile(dataPath, JSON.stringify(seed));
  let clock = Date.parse('2026-11-03T15:50:00.000Z');
  const now = () => clock;
  const server = createDemoServer({ dataPath, distPath: directory, now });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('focusdesk-focus-'));
    await rm(target, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async () => {
    const response = await fetch(origin + '/api/v1/daily-overview');
    assert.equal(response.status, 200);
    const body = await response.text(); assert.equal(Buffer.byteLength(body), Number(response.headers.get('content-length')));
    return parseDailyOverviewText(body);
  };
  const put = (input, resource = 'focus', headers = {}) => fetch(`${origin}/api/v1/daily-overview/${resource}`, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof input === 'string' ? input : JSON.stringify(input),
  });
  const start = async () => {
    const before = await read();
    const response = await put({ revision: before.revision, action: 'start', task_id: before.tasks[0].id });
    assert.equal(response.status, 200); return response.json();
  };
  return { directory, dataPath, now, advance: ms => { clock += ms; }, origin, read, put, start };
}

test('focus start persists fixed 25-minute server times, stable revisions, and survives restart', async t => {
  const { read, start, dataPath, now, advance } = await setup(t);
  const idle = await read(); assert.equal(idle.focus, null);
  const active = await start();
  assert.equal(active.focus.task_id, idle.tasks[0].id);
  assert.equal(active.focus.started_at, '2026-11-03T15:50:00.000Z');
  assert.equal(active.focus.ends_at, '2026-11-03T16:15:00.000Z');
  assert.notEqual(active.revision, idle.revision); assert.deepEqual(active.tasks, idle.tasks);
  assert.deepEqual((await createOverviewLoader(dataPath, { now }).load()), active);
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).focus, active.focus);
  advance(60_000); assert.deepEqual(await read(), active);
});

test('expiry changes the readable revision once, never rewrites on GET, and never completes tasks', async t => {
  const { start, dataPath, advance, read, put, now } = await setup(t);
  const active = await start(); const bytes = await readFile(dataPath);
  advance(FOCUS_DURATION_MS - 1); assert.deepEqual(await read(), active);
  advance(1); const idle = await read(); assert.equal(idle.focus, null);
  assert.notEqual(idle.revision, active.revision); assert.deepEqual(idle.tasks, active.tasks);
  assert.deepEqual(await readFile(dataPath), bytes);
  assert.deepEqual(await createOverviewLoader(dataPath, { now }).load(), idle);
  advance(300_000); assert.deepEqual(await read(), idle);
  assert.equal((await put({ revision: active.revision, action: 'stop' })).status, 409);
  assert.equal((await put({ revision: idle.revision, action: 'stop' })).status, 200);
  assert.deepEqual(await readFile(dataPath), bytes);
});

test('manual exit is atomic and leaves tasks unchanged; a new session can then start', async t => {
  const { start, read, put, dataPath, advance } = await setup(t); const active = await start();
  const stopped = await put({ revision: active.revision, action: 'stop' }); assert.equal(stopped.status, 200);
  const idle = await stopped.json(); assert.equal(idle.focus, null); assert.deepEqual(idle.tasks, active.tasks);
  assert.equal(JSON.parse(await readFile(dataPath, 'utf8')).focus, undefined);
  assert.deepEqual(await read(), idle);
  advance(60_000); assert.ok((await start()).focus);
});

test('rename preserves focus; completing or removing its task clears focus in the same save', async t => {
  const { start, read, put } = await setup(t); const active = await start();
  const renamed = await put({ revision: active.revision, tasks: active.tasks.map((task, i) => i ? task : { ...task, title: 'Updated focus task' }) }, 'tasks');
  assert.equal(renamed.status, 200); const updated = await renamed.json(); assert.deepEqual(updated.focus, active.focus);
  const completed = await put({ revision: updated.revision, tasks: updated.tasks.map((task, i) => i ? task : { ...task, status: 'done' }) }, 'tasks');
  assert.equal(completed.status, 200); const idle = await completed.json(); assert.equal(idle.focus, null);
  const started = await put({ revision: idle.revision, action: 'start', task_id: idle.tasks[2].id });
  assert.equal(started.status, 200); const second = await started.json();
  const removed = await put({ revision: second.revision, tasks: second.tasks.slice(0, 2) }, 'tasks');
  assert.equal(removed.status, 200); assert.equal((await read()).focus, null);
});

test('bad/stale/already-active starts cannot overwrite the persisted focus', async t => {
  const { read, put, dataPath, start } = await setup(t); const idle = await read();
  for (const task_id of ['missing', idle.tasks[1].id]) {
    const response = await put({ revision: idle.revision, action: 'start', task_id });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_FOCUS_UPDATE');
  }
  const active = await start(); const bytes = await readFile(dataPath);
  const stale = await put({ revision: idle.revision, action: 'start', task_id: idle.tasks[2].id });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
  const duplicate = await put({ revision: active.revision, action: 'start', task_id: idle.tasks[2].id });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'FOCUS_ALREADY_ACTIVE');
  assert.deepEqual(await readFile(dataPath), bytes);
});

test('focus and task writes share the version queue and permit only one concurrent winner', async t => {
  const { read, put } = await setup(t); const idle = await read();
  const outcomes = await Promise.all([
    put({ revision: idle.revision, action: 'start', task_id: idle.tasks[0].id }),
    put({ revision: idle.revision, tasks: [] }, 'tasks'),
  ]);
  assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
  const winner = await outcomes.find(response => response.status === 200).json(); assert.deepEqual(await read(), winner);
});

test('focus endpoint enforces existing write policy, payload limits, and method checks', async t => {
  const { put, origin, dataPath } = await setup(t); const bytes = await readFile(dataPath);
  for (const [input, headers, status] of [
    ['{}', { Origin: '' }, 403], ['{}', { Origin: 'http://elsewhere.example' }, 403],
    ['{}', { 'Content-Type': 'text/plain' }, 415], ['{', {}, 400], [' '.repeat(4097), {}, 413],
    [{ revision: 'base', action: 'start', task_id: 'task', duration: 1 }, {}, 400],
  ]) assert.equal((await put(input, 'focus', headers)).status, status);
  assert.equal((await fetch(origin + '/api/v1/daily-overview/focus')).status, 405);
  assert.deepEqual(await readFile(dataPath), bytes);
});

test('failed focus persistence keeps original bytes and removes temporary files', async t => {
  const { dataPath, now, directory } = await setup(t); const bytes = await readFile(dataPath);
  const store = createOverviewLoader(dataPath, { now, replace: async () => { throw new Error('simulated failure'); } });
  const idle = await store.load();
  await assert.rejects(store.updateFocus({ revision: idle.revision, action: 'start', task_id: idle.tasks[0].id }), error => error.code === 'TASK_SOURCE_WRITE_FAILED');
  assert.deepEqual(await readFile(dataPath), bytes); assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});
