import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoServer } from '../src/service.ts';
import { createOverviewLoader } from '../src/overview-loader.ts';
import { checkWritePolicy } from '../src/write-policy.ts';
import { parseTaskUpdateRequest } from '../../contracts/task-update.ts';
import { MAX_TASKS } from '../../contracts/daily-overview.ts';

const fixture = JSON.parse(await readFile(new URL('../../contracts/fixtures/device-demo.json', import.meta.url), 'utf8'));
const seed = { date: fixture.date, timezone: fixture.timezone, tasks: fixture.tasks };

async function setup(t, timeout = 5000) {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-write-'));
  const dataPath = path.join(directory, 'tasks.json');
  await writeFile(dataPath, JSON.stringify(seed, null, 2));
  const distPath = path.join(directory, 'dist'); await mkdir(distPath);
  const server = createDemoServer({ dataPath, distPath, writeTimeoutMs: timeout });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('focusdesk-write-'));
    await rm(target, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async () => { const response = await fetch(origin + '/api/v1/daily-overview'); assert.equal(response.status, 200); return response.json(); };
  const put = (input, headers = {}) => fetch(origin + '/api/v1/daily-overview/tasks', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof input === 'string' || input instanceof Uint8Array ? input : JSON.stringify(input),
  });
  return { directory, dataPath, origin, read, put };
}

test('saves task changes atomically, preserves metadata, and survives a fresh store', async t => {
  const { dataPath, read, put, directory } = await setup(t);
  const first = await read();
  const tasks = [{ ...first.tasks[0], title: 'Saved from web', status: 'done' },
    ...Array.from({ length: MAX_TASKS - 1 }, (_, index) => ({ id: `new-task-${index}`, title: `New task ${index + 2}`, status: 'todo', due_at: null }))];
  const response = await put({ revision: first.revision, tasks });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.tasks, tasks); assert.notEqual(saved.revision, first.revision);
  assert.equal(saved.date, first.date); assert.equal(saved.timezone, first.timezone);
  assert.deepEqual(await read(), saved);
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), { date: first.date, timezone: first.timezone, tasks });
  assert.deepEqual((await createOverviewLoader(dataPath).load()).tasks, tasks);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('equivalent save does not rewrite a file or change its version', async t => {
  const { dataPath, read, put } = await setup(t);
  const first = await read(); const original = await readFile(dataPath); const before = await stat(dataPath);
  const response = await put({ revision: first.revision, tasks: first.tasks });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), first);
  assert.deepEqual(await readFile(dataPath), original); assert.equal((await stat(dataPath)).mtimeMs, before.mtimeMs);
});

test('an explicit empty list persists as a new readable no-task snapshot', async t => {
  const { read, put } = await setup(t); const first = await read();
  const response = await put({ revision: first.revision, tasks: [] });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).tasks, []);
  assert.deepEqual((await read()).tasks, []);
});

test('concurrent writes from the same base allow one winner and one conflict', async t => {
  const { read, put } = await setup(t); const first = await read();
  const outcomes = await Promise.all(['Draft A', 'Draft B'].map(title => put({
    revision: first.revision, tasks: [{ ...first.tasks[0], title }],
  })));
  assert.deepEqual(outcomes.map(x => x.status).sort(), [200, 409]);
  const winner = await outcomes.find(x => x.status === 200).json();
  assert.deepEqual(await read(), winner);
  assert.equal((await outcomes.find(x => x.status === 409).json()).error.code, 'REVISION_CONFLICT');
});

test('external changes conflict with an older browser draft without being overwritten', async t => {
  const { dataPath, read, put } = await setup(t); const first = await read();
  const external = { ...seed, tasks: [{ ...seed.tasks[0], title: 'External edit' }] };
  await writeFile(dataPath, JSON.stringify(external));
  const response = await put({ revision: first.revision, tasks: [] });
  assert.equal(response.status, 409); assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), external);
});

for (const [name, body, headers, expected] of [
  ['missing origin', '{}', { Origin: '' }, 403],
  ['cross origin', '{}', { Origin: 'http://other.example' }, 403],
  ['text payload', '{}', { 'Content-Type': 'text/plain' }, 415],
  ['invalid JSON', '{', {}, 400],
  ['invalid UTF8', new Uint8Array([0xff]), {}, 400],
  ['oversized body', ' '.repeat(4097), {}, 413],
]) {
  test(`rejects ${name} and preserves the file`, async t => {
    const { put, dataPath } = await setup(t); const original = await readFile(dataPath);
    const response = await put(body, headers); assert.equal(response.status, expected);
    assert.ok((await response.json()).error.code); assert.deepEqual(await readFile(dataPath), original);
  });
}

test('rejects invalid task fields and attempts to write date/timezone', async t => {
  const { read, put, dataPath } = await setup(t); const first = await read(); const original = await readFile(dataPath);
  for (const input of [
    { revision: first.revision, tasks: [{ ...first.tasks[0], title: '中文' }] },
    { revision: first.revision, tasks: first.tasks, date: '2026-11-03' },
    { revision: first.revision, tasks: Array.from({ length: MAX_TASKS + 1 }, (_, index) => ({ ...first.tasks[0], id: `task-${index}` })) },
  ]) assert.equal((await put(input)).status, 400);
  assert.deepEqual(await readFile(dataPath), original);
});

test('checks the real response size before saving a request that fits the temporary DTO', async t => {
  const { read, put, dataPath } = await setup(t); const first = await read(); const original = await readFile(dataPath);
  const task = { id: 'large', title: 'Valid task', status: 'todo', due_at: '2026-11-03T01:00:00.1Z' };
  const candidate = { schema_version: '1.0', revision: first.revision, date: '2000-01-01', timezone: 'UTC', updated_at: '2000-01-01T00:00:00Z', tasks: [task] };
  const padding = 4096 - Buffer.byteLength(JSON.stringify(candidate));
  task.due_at = task.due_at.slice(0, -1) + '1'.repeat(padding) + 'Z';
  const input = { revision: first.revision, tasks: [task] };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 4096); parseTaskUpdateRequest(input);
  assert.equal((await put(input)).status, 400);
  assert.deepEqual(await readFile(dataPath), original);
});

test('failed atomic replacement keeps original data and removes its own temporary file', async t => {
  const { dataPath, directory } = await setup(t); const original = await readFile(dataPath);
  const store = createOverviewLoader(dataPath, { replace: async () => { throw new Error('simulated rename failure'); } });
  const first = await store.load();
  await assert.rejects(store.update({ revision: first.revision, tasks: [] }), error => error.code === 'TASK_SOURCE_WRITE_FAILED');
  assert.deepEqual(await readFile(dataPath), original);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('detects an external edit while preparing the temporary file', async t => {
  const { dataPath, directory } = await setup(t);
  const external = { ...seed, tasks: [{ ...seed.tasks[0], title: 'External during save' }] };
  const store = createOverviewLoader(dataPath, { openTemporary: async (...args) => {
    const handle = await open(...args); await writeFile(dataPath, JSON.stringify(external)); return handle;
  } });
  const first = await store.load();
  await assert.rejects(store.update({ revision: first.revision, tasks: [] }), { name: 'RevisionConflictError' });
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), external);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('write policy rejects LAN peers and rebinding hostnames', () => {
  assert.throws(() => checkWritePolicy('192.168.1.2', '127.0.0.1:8787', 'http://127.0.0.1:8787', 'application/json'));
  assert.throws(() => checkWritePolicy('127.0.0.1', 'evil.example:8787', 'http://evil.example:8787', 'application/json'));
  assert.doesNotThrow(() => checkWritePolicy('::ffff:127.0.0.1', 'localhost:8787', 'http://localhost:8787', 'application/json; charset=utf-8'));
});

test('incomplete uploads time out without changing the source', async t => {
  const { origin, dataPath } = await setup(t, 100); const original = await readFile(dataPath);
  const status = await new Promise((resolve, reject) => {
    const req = request(origin + '/api/v1/daily-overview/tasks', { method: 'PUT', headers: {
      Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '100',
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.write('{');
  });
  assert.equal(status, 408); assert.deepEqual(await readFile(dataPath), original);
});
