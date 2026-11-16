import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoServer } from '../src/service.ts';
import { MAX_OVERVIEW_BYTES, MAX_TASKS, parseDailyOverviewText } from '../../contracts/daily-overview.ts';

const fixture = JSON.parse(await readFile(new URL('../../contracts/fixtures/device-demo.json', import.meta.url), 'utf8'));
const seed = { date: fixture.date, timezone: fixture.timezone, tasks: fixture.tasks };

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-backend-'));
  const dataPath = path.join(directory, 'tasks.json');
  const distPath = path.join(directory, 'dist');
  await mkdir(path.join(distPath, 'assets'), { recursive: true });
  await writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>FocusDesk demo</title>');
  await writeFile(path.join(distPath, 'assets', 'app.js'), 'console.log("FocusDesk");');
  const write = async (value, stamp = '2026-11-02T01:00:00Z') => {
    await writeFile(dataPath, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
    await utimes(dataPath, new Date(stamp), new Date(stamp));
  };
  await write(structuredClone(seed));
  const server = createDemoServer({ dataPath, distPath });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('focusdesk-backend-')) throw new Error('Refusing unexpected temporary cleanup target.');
    await rm(target, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const get = (url = '/api/v1/daily-overview', method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: url, method, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body, json: () => JSON.parse(body) });
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  return { get, write, dataPath, directory, distPath };
}

test('serves the shared device seed with a bounded JSON body and explicit uncompressed length', async t => {
  const { get } = await setup(t);
  const response = await get();
  assert.equal(response.status, 200);
  const overview = parseDailyOverviewText(response.body);
  assert.deepEqual(overview.tasks, fixture.tasks);
  assert.equal(overview.date, fixture.date);
  assert.equal(overview.timezone, fixture.timezone);
  assert.match(overview.revision, /^[a-f0-9]{64}$/);
  assert.equal(overview.updated_at, '2026-11-02T01:00:00.000Z');
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.headers['transfer-encoding'], undefined);
});

test('serves the simulator as an app page while keeping unknown API and file paths unavailable', async t => {
  const { get } = await setup(t);
  const dashboard = await get('/');
  for (const pathname of ['/simulator', '/simulator/', '/simulator?mode=device']) {
    const response = await get(pathname);
    assert.equal(response.status, 200);
    assert.equal(response.body, dashboard.body);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  }
  const head = await get('/simulator', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal((await get('/api/simulator')).status, 404);
  assert.equal((await get('/simulator/unknown')).status, 404);
});

test('repeated reads and whitespace/property-order edits keep revision and updated_at stable', async t => {
  const { get, write } = await setup(t);
  const first = (await get()).json();
  assert.deepEqual((await get()).json(), first);
  await write(JSON.stringify({ tasks: seed.tasks, timezone: seed.timezone, date: seed.date }, null, 2), '2026-11-02T02:00:00Z');
  assert.deepEqual((await get()).json(), first);
});

for (const [name, mutate] of [
  ['title', value => { value.tasks[0].title = 'A changed task'; }],
  ['status', value => { value.tasks[0].status = 'done'; }],
  ['order', value => { value.tasks.reverse(); }],
  ['date', value => { value.date = '2026-11-03'; }],
  ['timezone', value => { value.timezone = 'UTC'; }],
]) {
  test(`${name} change publishes a new revision with file mtime`, async t => {
    const { get, write } = await setup(t);
    const initial = (await get()).json();
    const value = structuredClone(seed);
    mutate(value);
    await write(value, '2026-11-02T03:00:00Z');
    const updated = (await get()).json();
    assert.notEqual(updated.revision, initial.revision);
    assert.equal(updated.updated_at, '2026-11-02T03:00:00.000Z');
    assert.deepEqual((await get()).json(), updated);
  });
}

test('empty tasks are a successful new snapshot', async t => {
  const { get, write } = await setup(t);
  const before = (await get()).json();
  await write({ ...seed, tasks: [] });
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json().tasks, []);
  assert.notEqual(response.json().revision, before.revision);
});

for (const [name, value, code] of [
  ['invalid JSON', '{', 'INVALID_TASK_SOURCE'],
  ['invalid UTF-8', new Uint8Array([0xff]), 'INVALID_TASK_SOURCE'],
  ['invalid date', { ...seed, date: '2026-02-30' }, 'INVALID_TASK_SOURCE'],
  ['unknown source field', { ...seed, revision: 'user-controlled' }, 'INVALID_TASK_SOURCE'],
  ['too many tasks', { ...seed, tasks: Array.from({ length: MAX_TASKS + 1 }, (_, index) => ({ ...seed.tasks[0], id: `task-${index}` })) }, 'INVALID_TASK_SOURCE'],
  ['bad device alias', { ...seed, tasks: [{ ...seed.tasks[0], device_title: '中文' }] }, 'INVALID_TASK_SOURCE'],
  ['unsupported device timezone', { ...seed, timezone: 'Europe/London' }, 'UNSUPPORTED_DEVICE_TIMEZONE'],
  ['oversized bytes including whitespace', ' '.repeat(4097), 'TASK_SOURCE_TOO_LARGE'],
]) {
  test(`${name} returns a structured 503 instead of stale success`, async t => {
    const { get, write } = await setup(t);
    const previous = (await get()).json();
    await write(value);
    const response = await get();
    assert.equal(response.status, 503);
    assert.equal(response.json().error.code, code);
    assert.equal(response.json().tasks, undefined);
    await write(seed);
    assert.equal((await get()).json().revision, previous.revision);
  });
}

test('4096 raw source bytes are accepted but 4097 are rejected', async t => {
  const { get, write } = await setup(t);
  const body = JSON.stringify(seed);
  const padded = body + ' '.repeat(4096 - Buffer.byteLength(body));
  await write(padded);
  assert.equal((await get()).status, 200);
  await write(padded + ' ');
  assert.equal((await get()).json().error.code, 'TASK_SOURCE_TOO_LARGE');
});

test('a 4 KiB workspace keeps its Chinese titles while the legacy device view compacts only expanded labels', async t => {
  const { get, write } = await setup(t);
  const tasks = [
    { id: 'frames', title: '检查双床房窗框', status: 'todo', due_at: '2026-11-03T01:00:00.1Z' },
    { id: 'windows', title: '装修双窗框', status: 'todo', due_at: null },
    { id: 'meeting', title: '周会', device_title: 'Team sync', status: 'todo', due_at: null },
    { id: 'read', title: 'Read notes', status: 'done', due_at: null },
  ];
  const endpoint = '/api/v1/daily-overview';
  await write({ ...seed, tasks });
  const workspace = await get(endpoint + '?view=workspace');
  const device = await get(endpoint + '?view=device');
  assert.equal(workspace.status, 200);
  assert.equal(device.status, 200);
  assert.match(device.json().tasks[0].title, /^Jian cha shuang /);
  assert.match(device.json().tasks[1].title, /^Zhuang xiu /);
  assert.equal(device.json().tasks[2].title, 'Team sync');

  // Fractional seconds allow a valid timestamp to exercise the exact transport limit.
  const padding = MAX_OVERVIEW_BYTES - Buffer.byteLength(workspace.body);
  assert.ok(padding > 0);
  assert.ok(Buffer.byteLength(device.body) + padding > MAX_OVERVIEW_BYTES, 'the full pinyin DTO would exceed the limit');
  tasks[0].due_at = tasks[0].due_at.slice(0, -1) + '1'.repeat(padding) + 'Z';
  await write({ ...seed, tasks });

  const full = await get(endpoint + '?view=workspace');
  const compact = await get(endpoint + '?view=device');
  assert.equal(full.status, 200);
  assert.equal(Buffer.byteLength(full.body), MAX_OVERVIEW_BYTES);
  assert.deepEqual(full.json().tasks, tasks);
  assert.equal(compact.status, 200);
  const bytes = Buffer.byteLength(compact.body);
  assert.ok(bytes <= MAX_OVERVIEW_BYTES);
  assert.equal(Number(compact.headers['content-length']), bytes);
  const expectedLabels = ['1', '2', 'Team sync', 'Read notes'];
  assert.deepEqual(parseDailyOverviewText(compact.body).tasks, tasks.map((task, index) => ({
    id: task.id, title: expectedLabels[index], status: task.status, due_at: task.due_at,
  })));
  assert.deepEqual((await get(endpoint + '?view=workspace')).json(), full.json());
});

test('missing task file remains missing and returns 503 without being recreated', async t => {
  const { get, dataPath } = await setup(t);
  await rm(dataPath);
  const response = await get();
  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, 'TASK_SOURCE_UNAVAILABLE');
  await assert.rejects(readFile(dataPath), { code: 'ENOENT' });
});

test('HEAD matches API headers and sends no body, including failures', async t => {
  const { get, write } = await setup(t);
  const success = await get();
  const head = await get('/api/v1/daily-overview', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], success.headers['content-type']);
  assert.equal(head.headers['content-length'], success.headers['content-length']);
  await write('{');
  const failed = await get();
  const failedHead = await get('/api/v1/daily-overview', 'HEAD');
  assert.equal(failedHead.status, 503);
  assert.equal(failedHead.body, '');
  assert.equal(failedHead.headers['content-length'], failed.headers['content-length']);
});

test('serves Dashboard/static assets and HEAD without exposing source/data', async t => {
  const { get } = await setup(t);
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /FocusDesk demo/);
  const asset = await get('/assets/app.js?version=1');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
  const head = await get('/assets/app.js', 'HEAD');
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], asset.headers['content-length']);
  for (const url of ['/data/tasks.json', '/src/service.ts', '/contracts/daily-overview.ts', '/assets/app.js.map', '/api/unknown', '/does-not-exist']) {
    const response = await get(url);
    assert.equal(response.status, 404, url);
    assert.doesNotMatch(response.body, /FocusDesk demo|Plan today/);
  }
});

test('rejects raw/encoded traversal, backslashes, dotfiles, and malformed paths', async t => {
  const { get } = await setup(t);
  for (const url of ['/../tasks.json', '/%2e%2e/tasks.json', '/assets/%2e%2e/%2e%2e/tasks.json', '/%5c..%5ctasks.json', '/.env', '/C:/Windows/test.html', '/%00.html']) {
    assert.equal((await get(url)).status, 403, url);
  }
  assert.equal((await get('/%zz')).status, 400);
});

test('does not follow static directory symlinks outside dist', async t => {
  const { get, directory, distPath } = await setup(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.html'), 'private external content');
  await symlink(outside, path.join(distPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const response = await get('/escape/secret.html');
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /private external content/);
});

test('rejects writes and never treats an unknown API as the Dashboard', async t => {
  const { get } = await setup(t);
  const response = await get('/api/v1/daily-overview', 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
  assert.equal((await get('/api/v1/missing')).status, 404);
  assert.equal((await get('/')).status, 200);
});
