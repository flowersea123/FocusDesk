import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOverviewLoader } from '../src/overview-loader.ts';
import { createDemoServer } from '../src/service.ts';

const midnight = Date.parse('2026-11-16T16:00:00.000Z');
const reading = {
  id: 'src-' + 'a'.repeat(43), title: '阅读学生周材料', deviceTitle: 'Read student week',
  plannedDate: '2026-11-17', dueDate: '2026-11-27', dueAt: null,
  source: 'mail', sourceTitle: '学生周阅读提醒',
};
const ordinary = index => ({ id: 'task-' + index, title: 'Existing ' + index, status: 'todo', due_at: null });
const planned = (store, snapshot, entry, extra) => store.updateCalendar('PUT', { revision: snapshot.revision, entry, ...extra });

async function setup(t, tasks = [], timezone = 'Asia/Shanghai') {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-calendar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'tasks.json');
  await writeFile(dataPath, JSON.stringify({ date: '2026-01-01', timezone, tasks }));
  let time = midnight - 1;
  const now = () => time;
  return { dir, dataPath, now, clock: value => { time = value; }, store: createOverviewLoader(dataPath, { now }) };
}

async function hub(t, fixture) {
  const server = createDemoServer({ dataPath: fixture.dataPath, distPath: fixture.dir, now: fixture.now, loader: fixture.store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    get: pathname => fetch(origin + pathname),
    putTasks: payload => fetch(origin + '/api/v1/daily-overview/tasks', {
      method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
    write: (method, payload, headers = {}) => fetch(origin + '/api/v1/calendar', {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
    }),
  };
}

test('device-only polling publishes at local midnight without a browser, retains the real date-only deadline', async t => {
  const fixture = await setup(t, Array.from({ length: 5 }, (_, i) => ordinary(i)));
  const { get, write } = await hub(t, fixture);
  const calendar = await (await get('/api/v1/calendar')).json();
  assert.equal(calendar.today, '2026-11-16');
  assert.equal(calendar.timezone, 'Asia/Shanghai');
  const saved = await write('PUT', { revision: calendar.revision, entry: reading });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).entries, [{ ...reading, status: 'scheduled' }]);
  const deviceText = async () => {
    const response = await get('/api/v1/display-snapshot');
    assert.equal(response.status, 200);
    return (await response.json()).commands.filter(cmd => cmd[0] === 1).map(cmd => cmd[5]);
  };
  assert.ok(!(await deviceText()).includes(reading.deviceTitle));
  fixture.clock(midnight);
  assert.ok((await deviceText()).includes(reading.deviceTitle));
  const overview = await (await get('/api/v1/daily-overview')).json();
  assert.equal(overview.date, '2026-11-17');
  assert.deepEqual(overview.tasks[0], { id: reading.id, title: reading.deviceTitle, status: 'todo', due_at: null });
  assert.deepEqual(overview.tasks.slice(1), Array.from({ length: 5 }, (_, i) => ordinary(i)));
  assert.deepEqual((await (await get('/api/v1/calendar')).json()).entries, [{ ...reading, status: 'published' }]);
  await deviceText();
  assert.equal((await fixture.store.load()).revision, overview.revision);
});

test('catch-up after missed days and restart uses the configured timezone and publishes exactly once', async t => {
  const f = await setup(t, [], 'UTC');
  const due = { ...reading, dueAt: '2026-11-27T12:30:00.000Z' };
  await planned(f.store, await f.store.readCalendar(), due);
  f.clock(midnight);
  assert.equal((await f.store.readCalendar()).today, '2026-11-16');
  assert.equal((await f.store.load()).tasks.length, 0);
  f.clock(Date.parse('2026-11-19T00:00:00Z'));
  const restored = createOverviewLoader(f.dataPath, { now: f.now });
  const results = await Promise.all([restored.load(), restored.load(), restored.load()]);
  for (const view of results) {
    assert.equal(view.date, '2026-11-19');
    assert.equal(view.tasks.length, 1);
    assert.equal(view.tasks[0].due_at, due.dueAt);
  }
  assert.equal((await restored.readCalendar()).entries[0].status, 'published');
});

test('a prior DDL import moves off the device until the selected date; repeats do not duplicate or undo deletion', async t => {
  const prior = { ...ordinary(1), id: reading.id, title: 'Legacy import' };
  const { store, clock } = await setup(t, [prior, ordinary(2)]);
  const initial = await store.readCalendar();
  const schedule = await planned(store, initial, reading);
  assert.deepEqual((await store.load()).tasks, [ordinary(2)]);
  assert.deepEqual(await planned(store, initial, reading), schedule);
  let overview = await store.load();
  await assert.rejects(store.update({ revision: overview.revision, tasks: [...overview.tasks, prior] }), { status: 409 });
  clock(midnight);
  overview = await store.load();
  assert.deepEqual(overview.tasks.map(t => t.id), [reading.id, ordinary(2).id]);
  await store.update({ revision: overview.revision, tasks: [ordinary(2)] });
  const removed = await store.readCalendar();
  assert.equal(removed.entries[0].status, 'removed');
  assert.deepEqual(await planned(store, initial, reading), removed);
  await assert.rejects(planned(store, removed, { ...reading, plannedDate: '2026-11-18' }), { status: 409 });
  const restored = await planned(store, removed, reading, { restore: true });
  assert.equal(restored.entries[0].status, 'published');
  const deleted = await store.updateCalendar('DELETE', { revision: restored.revision, id: reading.id });
  assert.equal(deleted.entries[0].status, 'removed');
  assert.deepEqual((await store.load()).tasks, [ordinary(2)]);
  assert.deepEqual(await store.updateCalendar('DELETE', { revision: restored.revision, id: reading.id }), deleted);
});

test('a confirmed legacy file import cannot undo a later calendar date or restore a removed source', async t => {
  const f = await setup(t, [ordinary(2)]);
  const calendar = await planned(f.store, await f.store.readCalendar(), reading);
  const source = { date: '2026-11-16', timezone: 'Asia/Shanghai', tasks: [{ ...ordinary(1), id: reading.id }] };
  const options = { revision: (await f.store.load()).revision, confirmed: true, backupsPath: path.join(f.dir, 'backups') };
  await assert.rejects(f.store.importSource(source, options), { status: 409 });
  await f.store.updateCalendar('DELETE', { revision: calendar.revision, id: reading.id });
  await assert.rejects(f.store.importSource(source, options), { status: 409 });
  assert.deepEqual((await f.store.load()).tasks, [ordinary(2)]);
});

test('daily-list undo restores one published mail in its position with its prior title and completion', async t => {
  const f = await setup(t, [ordinary(1), ordinary(2)]);
  f.clock(midnight);
  const { putTasks } = await hub(t, f);
  await planned(f.store, await f.store.readCalendar(), reading);
  let before = await f.store.load();
  const done = { ...before.tasks[0], title: 'My edited title', status: 'done' };
  const edited = [ordinary(1), done, ordinary(2)];
  before = await (await putTasks({ revision: before.revision, tasks: edited })).json();
  const removed = await (await putTasks({ revision: before.revision, tasks: [ordinary(1), ordinary(2)] })).json();
  assert.equal((await f.store.readCalendar()).entries[0].status, 'removed');
  const revert = { revision: removed.revision, tasks: edited, restoreTaskId: reading.id };
  assert.equal((await putTasks({ revision: removed.revision, tasks: edited })).status, 409);
  assert.equal((await putTasks({ ...revert, revision: before.revision })).status, 409);
  assert.equal((await putTasks({ ...revert, restoreTaskId: 'unrelated' })).status, 400);
  assert.equal((await putTasks({ ...revert, restoreTaskId: ordinary(1).id })).status, 409);
  assert.equal((await putTasks({ ...revert, tasks: [ordinary(1), done, { ...ordinary(2), title: 'Also changed' }] })).status, 409);
  const result = await putTasks(revert);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).tasks, edited);
  const restarted = createOverviewLoader(f.dataPath, { now: f.now });
  assert.deepEqual((await restarted.load()).tasks, edited);
  assert.equal((await restarted.readCalendar()).entries[0].status, 'done');
});

test('stale daily undo cannot override a new future plan or an explicit calendar removal', async t => {
  const f = await setup(t);
  f.clock(midnight);
  await planned(f.store, await f.store.readCalendar(), reading);
  const published = await f.store.load();
  const empty = await f.store.update({ revision: published.revision, tasks: [] });
  const revert = { revision: empty.revision, tasks: published.tasks, restoreTaskId: reading.id };
  const future = { ...reading, plannedDate: '2026-11-24' };
  await planned(f.store, await f.store.readCalendar(), future, { restore: true });
  await assert.rejects(f.store.update(revert), { status: 409 });
  const rescheduled = await planned(f.store, await f.store.readCalendar(), reading);
  await f.store.updateCalendar('DELETE', { revision: rescheduled.revision, id: reading.id });
  assert.equal((await f.store.load()).revision, empty.revision);
  await assert.rejects(f.store.update(revert), { status: 409 });
  assert.equal((await f.store.load()).tasks.length, 0);
});

test('an interrupted daily undo leaves the tombstone retryable and preserves ordinary task undo', async t => {
  const f = await setup(t, [ordinary(1)]);
  f.clock(midnight);
  await planned(f.store, await f.store.readCalendar(), reading);
  const before = await f.store.load();
  const empty = await f.store.update({ revision: before.revision, tasks: [] });
  const ordinaryUndo = await f.store.update({ revision: empty.revision, tasks: [ordinary(1)], restoreTaskId: ordinary(1).id });
  assert.deepEqual(ordinaryUndo.tasks, [ordinary(1)]);
  const revert = { revision: ordinaryUndo.revision, tasks: before.tasks, restoreTaskId: reading.id };
  const failing = createOverviewLoader(f.dataPath, { now: f.now, replace: async () => { throw Error('simulated failure'); } });
  await assert.rejects(failing.update(revert), { code: 'TASK_SOURCE_WRITE_FAILED' });
  const restarted = createOverviewLoader(f.dataPath, { now: f.now });
  assert.deepEqual((await restarted.load()).tasks, [ordinary(1)]);
  assert.equal((await restarted.readCalendar()).entries[0].status, 'removed');
  assert.deepEqual((await restarted.update(revert)).tasks, before.tasks);
  assert.equal((await restarted.readCalendar()).entries[0].status, 'published');
});

test('capacity queues a due item and releases it on an ordinary task edit without replacing any other rows', async t => {
  const tasks = Array.from({ length: 10 }, (_, i) => ordinary(i));
  const { store, clock } = await setup(t, tasks);
  await planned(store, await store.readCalendar(), reading);
  clock(midnight);
  const full = await store.load();
  assert.deepEqual(full.tasks, tasks);
  assert.equal((await store.readCalendar()).entries[0].status, 'waiting');
  const after = await store.update({ revision: full.revision, tasks: tasks.slice(0, -1) });
  assert.deepEqual(after.tasks.map(t => t.id), [reading.id, ...tasks.slice(0, -1).map(t => t.id)]);
  assert.equal((await store.readCalendar()).entries[0].status, 'published');
});

test('the 4096-byte limit queues an item even when there is room in the task count', async t => {
  const large = { ...ordinary(0), due_at: '2026-11-16T00:00:00.' + '1'.repeat(3710) + 'Z' };
  const { clock, store, dataPath } = await setup(t, [large]);
  await planned(store, await store.readCalendar(), reading);
  const initial = await readFile(dataPath, 'utf8');
  clock(midnight);
  assert.equal((await store.readCalendar()).entries[0].status, 'waiting');
  assert.equal(await readFile(dataPath, 'utf8'), initial);
  const current = await store.load();
  const after = await store.update({ revision: current.revision, tasks: [ordinary(0)] });
  assert.deepEqual(after.tasks.map(task => task.id), [reading.id, ordinary(0).id]);
  assert.ok(Buffer.byteLength(JSON.stringify(after)) <= 4096);
});

test('active focus guards rescheduling, and completion is preserved through repeated imports', async t => {
  const { store, clock } = await setup(t);
  clock(midnight);
  let calendar = await planned(store, await store.readCalendar(), reading);
  let overview = await store.load();
  overview = await store.updateFocus({ revision: overview.revision, action: 'start', task_id: reading.id });
  const future = { ...reading, plannedDate: '2026-11-21' };
  await assert.rejects(planned(store, calendar, future), { status: 409 });
  await assert.rejects(store.updateCalendar('DELETE', { revision: calendar.revision, id: reading.id }), { status: 409 });
  assert.equal((await store.load()).focus.task_id, reading.id);
  await store.update({ revision: overview.revision, tasks: [{ ...overview.tasks[0], status: 'done' }] });
  calendar = await store.readCalendar();
  assert.equal(calendar.entries[0].status, 'done');
  await assert.rejects(planned(store, calendar, future), { status: 409 });
  await assert.rejects(store.updateCalendar('DELETE', { revision: calendar.revision, id: reading.id }), { status: 409 });
  assert.deepEqual(await planned(store, calendar, reading), calendar);
  assert.equal((await store.load()).tasks[0].status, 'done');
});

test('two conflicting writes from the same base have one winner, and a delayed identical retry is harmless', async t => {
  const { store } = await setup(t);
  const base = await store.readCalendar();
  const choices = ['2026-11-18', '2026-11-19'].map(plannedDate => ({ ...reading, plannedDate }));
  const results = await Promise.allSettled(choices.map(item => planned(store, base, item)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const saved = await store.readCalendar();
  const winner = choices.find(c => c.plannedDate === saved.entries[0].plannedDate);
  assert.deepEqual(await planned(store, base, winner), saved);
});

test('private HTTP routes validate source IDs, real dates, display text, optimistic revision and write origin', async t => {
  const { get, write } = await hub(t, await setup(t));
  const revision = (await (await get('/api/v1/calendar')).json()).revision;
  for (const invalid of [
    { plannedDate: '2026-02-29' }, { deviceTitle: '中文' }, { title: 'a\nb' }, { dueAt: '2026-11-17T00:00:00+08:00' },
    { dueAt: '2026-11-26T00:00:00Z' }, { id: 'not-a-source-id' }, { source: 'manual' }, { source: 'other' }, { source: ['mail'] },
  ]) {
    assert.equal((await write('PUT', { revision, entry: { ...reading, ...invalid } })).status, 400);
  }
  assert.equal((await write('PUT', { revision, entry: reading }, { Origin: 'http://other.example' })).status, 403);
  assert.equal((await write('PUT', { revision, entry: reading }, { Origin: '' })).status, 403);
  assert.equal((await write('POST', {})).status, 405);
  assert.equal((await write('PUT', { revision: 'stale', entry: reading })).status, 409);
  assert.equal((await (await get('/api/v1/calendar')).json()).revision, revision);
});

test('a date without a clock, an exact fractional UTC deadline, and an undated mail remain distinguishable', async t => {
  const { store } = await setup(t);
  const precise = { ...reading, dueAt: '2026-11-26T18:00:00.1234500Z' };
  const formatted = await planned(store, await store.readCalendar(), precise);
  assert.equal(formatted.entries[0].dueAt, '2026-11-26T18:00:00.12345Z');
  assert.equal(formatted.entries[0].dueDate, '2026-11-27');
  const undated = { ...reading, id: 'src-' + 'b'.repeat(43), dueDate: null, dueAt: null };
  const after = await planned(store, formatted, undated);
  assert.deepEqual(after.entries.find(entry => entry.id === undated.id), { ...undated, status: 'scheduled' });
});

test('failure after recording intent leaves the previous daily file intact and recovers on restart', async t => {
  const f = await setup(t, [ordinary(1)]);
  f.clock(midnight);
  const original = await readFile(f.dataPath, 'utf8');
  const failing = createOverviewLoader(f.dataPath, { now: f.now, replace: async () => { throw Error('simulated failure'); } });
  await assert.rejects(planned(failing, await failing.readCalendar(), reading), { code: 'TASK_SOURCE_WRITE_FAILED' });
  assert.equal(await readFile(f.dataPath, 'utf8'), original);
  const recovered = await f.store.load();
  assert.deepEqual(recovered.tasks.map(task => task.id), [reading.id, ordinary(1).id]);
  assert.equal((await f.store.readCalendar()).entries[0].status, 'published');
});
