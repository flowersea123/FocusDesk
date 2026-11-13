import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOverviewLoader, RevisionConflictError } from '../src/overview-loader.ts';
import { createDemoServer } from '../src/service.ts';
import { validateDesktopSource } from '../src/desktop-data.ts';
import { buildDisplaySnapshot } from '../../contracts/display-snapshot.ts';

const source = {
  date: '2026-11-11', timezone: 'UTC',
  tasks: [{ id: 'draft', title: 'Draft the paper', status: 'todo', due_at: null }],
};
const work = { goal: 'Publish the paper', current_action: 'Write introduction', next_action: 'Review references' };
const signal = { id: 'manual-1', content: 'Reviewer available', source: 'Manual', created_at: '2026-11-11T08:00:00.000Z', priority: 'action_needed', status: 'active' };
const now = () => Date.parse('2026-11-11T08:01:00.000Z');

async function setup(t, seed = source, persistence = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-v02-work-'));
  const dataPath = path.join(directory, 'tasks.json');
  await writeFile(dataPath, JSON.stringify(seed));
  const loader = createOverviewLoader(dataPath, { now, ...persistence });
  t.after(async () => {
    await loader.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('focusdesk-v02-work-'));
    await rm(target, { recursive: true, force: true });
  });
  return { directory, dataPath, loader };
}

test('legacy sources retain their original task-only hash and do not acquire optional fields on read', async t => {
  const { loader, dataPath } = await setup(t);
  const before = await readFile(dataPath);
  const overview = await loader.load();
  assert.equal(overview.revision, createHash('sha256').update(JSON.stringify(source)).digest('hex'));
  assert.equal(overview.work_state, undefined);
  assert.equal(overview.signals, undefined);
  assert.deepEqual(await readFile(dataPath), before);
});

test('work state and manual signals persist atomically, preserve tasks, and survive a fresh loader', async t => {
  const { loader, dataPath, directory } = await setup(t);
  const before = await loader.load();
  const saved = await loader.updateWorkState({ revision: before.revision, work_state: work, signals: [signal] });
  assert.notEqual(saved.revision, before.revision);
  assert.deepEqual(saved.tasks, before.tasks);
  assert.deepEqual(saved.work_state, work);
  assert.deepEqual(saved.signals, [signal]);
  const restarted = createOverviewLoader(dataPath, { now });
  assert.deepEqual(await restarted.load(), saved);
  await restarted.close();
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), { ...source, work_state: work, signals: [signal] });
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('task edits, focus start/stop and task completion preserve work state and signal history', async t => {
  const { loader } = await setup(t, { ...source, work_state: work, signals: [signal] });
  let overview = await loader.load();
  overview = await loader.updateFocus({ revision: overview.revision, action: 'start', task_id: 'draft' });
  assert.ok(overview.focus);
  overview = await loader.update({ revision: overview.revision, tasks: [{ ...source.tasks[0], title: 'Refine paper' }] });
  assert.ok(overview.focus);
  overview = await loader.updateWorkState({ revision: overview.revision, work_state: { ...work, goal: 'Submit paper' }, signals: [{ ...signal, status: 'acknowledged' }] });
  assert.ok(overview.focus);
  const focused = overview.focus;
  overview = await loader.updateFocus({ revision: overview.revision, action: 'stop' });
  assert.equal(overview.focus, null);
  assert.deepEqual(overview.work_state, { ...work, goal: 'Submit paper' });
  assert.equal(overview.signals[0].status, 'acknowledged');
  overview = await loader.updateFocus({ revision: overview.revision, action: 'start', task_id: 'draft' });
  assert.deepEqual(overview.focus, focused);
  overview = await loader.update({ revision: overview.revision, tasks: [{ ...overview.tasks[0], status: 'done' }] });
  assert.equal(overview.focus, null);
  assert.equal(overview.work_state.goal, 'Submit paper');
  assert.equal(overview.signals[0].status, 'acknowledged');
});

test('equivalent work state saves preserve revision, raw data and modification time', async t => {
  const { loader, dataPath } = await setup(t, { ...source, work_state: work, signals: [signal] });
  const before = await loader.load();
  const raw = await readFile(dataPath);
  const info = await stat(dataPath);
  const saved = await loader.updateWorkState({ revision: before.revision, work_state: work, signals: [signal] });
  assert.deepEqual(saved, before);
  assert.deepEqual(await readFile(dataPath), raw);
  assert.equal((await stat(dataPath)).mtimeMs, info.mtimeMs);
});

test('work and task writes share one revision queue with only one concurrent winner', async t => {
  const { loader } = await setup(t);
  const before = await loader.load();
  const results = await Promise.allSettled([
    loader.updateWorkState({ revision: before.revision, work_state: work, signals: [signal] }),
    loader.update({ revision: before.revision, tasks: [] }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.find(result => result.status === 'rejected').reason instanceof RevisionConflictError);
  assert.deepEqual((await loader.load()).tasks, source.tasks);
});

test('stale, invalid and oversized work state drafts never replace saved bytes', async t => {
  const { loader, dataPath } = await setup(t);
  const before = await loader.load();
  const raw = await readFile(dataPath);
  await assert.rejects(loader.updateWorkState({ revision: 'stale', work_state: work, signals: [] }), RevisionConflictError);
  assert.throws(() => loader.updateWorkState({ revision: before.revision, work_state: { ...work, goal: '中文' }, signals: [] }));
  assert.throws(() => loader.updateWorkState({ revision: before.revision, work_state: work, signals: [signal, signal] }));
  assert.throws(() => loader.updateWorkState({ revision: before.revision, work_state: work, signals: [{ ...signal, status: 'automatic' }] }));
  assert.deepEqual(await readFile(dataPath), raw);
});

test('queued work state inputs are copied and cannot be changed by their caller', async t => {
  const { loader } = await setup(t);
  const before = await loader.load();
  const input = { revision: before.revision, work_state: { ...work }, signals: [{ ...signal }] };
  const saved = loader.updateWorkState(input);
  input.work_state.goal = 'Caller changed goal';
  input.signals[0].content = 'Caller changed signal';
  const result = await saved;
  assert.deepEqual(result.work_state, work);
  assert.deepEqual(result.signals, [signal]);
});

test('failed work state rename retains original data and removes only its temporary file', async t => {
  const { loader, dataPath, directory } = await setup(t, source, { replace: async () => { throw new Error('injected rename failure'); } });
  const before = await loader.load();
  const raw = await readFile(dataPath);
  await assert.rejects(loader.updateWorkState({ revision: before.revision, work_state: work, signals: [signal] }), { code: 'TASK_SOURCE_WRITE_FAILED' });
  assert.deepEqual(await readFile(dataPath), raw);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('desktop import validates extensions, preserves fields, and backs up the complete previous source', async t => {
  const original = { ...source, work_state: work, signals: [signal] };
  const { loader, dataPath, directory } = await setup(t, original);
  const before = await loader.load();
  const raw = await readFile(dataPath);
  const candidate = { ...source, work_state: { ...work, goal: 'Imported goal' }, signals: [{ ...signal, status: 'closed' }] };
  assert.deepEqual(validateDesktopSource(candidate), candidate);
  const backupsPath = path.join(directory, 'backups');
  const imported = await loader.importSource(candidate, { revision: before.revision, confirmed: true, backupsPath });
  assert.deepEqual(imported.work_state, candidate.work_state);
  assert.deepEqual(imported.signals, candidate.signals);
  const backups = await readdir(backupsPath);
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(backupsPath, backups[0])), raw);
  assert.throws(() => validateDesktopSource({ ...candidate, signals: [{ ...signal, priority: 'unknown' }] }), { code: 'IMPORT_INVALID_SOURCE' });
  const legacy = await loader.importSource(source, { revision: imported.revision, confirmed: true, backupsPath });
  assert.equal(legacy.work_state, undefined);
  assert.equal(legacy.signals, undefined);
});

async function serverSetup(t) {
  const environment = await setup(t);
  const server = createDemoServer({ dataPath: environment.dataPath, distPath: environment.directory, loader: environment.loader });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async () => (await fetch(origin + '/api/v1/daily-overview')).json();
  const put = (input, headers = {}) => fetch(origin + '/api/v1/daily-overview/work-state', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof input === 'string' ? input : JSON.stringify(input),
  });
  return { ...environment, origin, read, put };
}

test('work state HTTP updates enforce loopback same-origin policy, validation and revision protection', async t => {
  const { origin, read, put, dataPath } = await serverSetup(t);
  const before = await read();
  const raw = await readFile(dataPath);
  const input = { revision: before.revision, work_state: work, signals: [signal] };
  for (const headers of [{ Origin: '' }, { Origin: 'http://evil.example' }]) {
    const denied = await put(input, headers);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'WRITE_FORBIDDEN');
  }
  assert.equal((await put(input, { 'Content-Type': 'text/plain' })).status, 415);
  const invalid = await put({ ...input, work_state: { ...work, goal: 'A'.repeat(65) } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_WORK_STATE_UPDATE');
  assert.equal((await put(' '.repeat(4097))).status, 413);
  assert.deepEqual(await readFile(dataPath), raw);
  const method = await fetch(origin + '/api/v1/daily-overview/work-state');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'PUT');
  const savedResponse = await put(input);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.work_state, work);
  assert.deepEqual(saved.tasks, before.tasks);
  const stale = await put(input);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
});

test('display endpoint emits exactly the shared snapshot, with bounded GET/HEAD and no writes', async t => {
  const { origin, read, put, dataPath } = await serverSetup(t);
  const before = await read();
  assert.equal((await put({ revision: before.revision, work_state: work, signals: [signal] })).status, 200);
  const overview = await read();
  const raw = await readFile(dataPath);
  const response = await fetch(origin + '/api/v1/display-snapshot');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(Buffer.byteLength(body), Number(response.headers.get('content-length')));
  assert.ok(Buffer.byteLength(body) <= 4096);
  assert.deepEqual(JSON.parse(body), buildDisplaySnapshot(overview));
  const head = await fetch(origin + '/api/v1/display-snapshot', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
  assert.equal(await head.text(), '');
  assert.equal((await fetch(origin + '/api/v1/display-snapshot', { method: 'POST' })).status, 405);
  assert.deepEqual(await readFile(dataPath), raw);
});
