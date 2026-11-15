import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from '../../backend/src/service.ts';
import { parseDailyOverviewText } from '../../contracts/daily-overview.ts';
import { createOverviewLoader } from '../../backend/src/overview-loader.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('built Dashboard, focus writes and device reads share the same state through expiry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-focus-integration-'));
  const dataPath = path.join(directory, 'tasks.json');
  const fixture = JSON.parse(await readFile(path.join(root, 'contracts/fixtures/focus.json'), 'utf8'));
  const { focus, ...source } = fixture;
  await writeFile(dataPath, JSON.stringify({ date: source.date, timezone: source.timezone, tasks: source.tasks }));
  let now = Date.parse(focus.started_at);
  const server = createDemoServer({ dataPath, distPath: path.join(root, 'frontend/dist'), now: () => now });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('focusdesk-focus-integration-')) throw new Error('Unexpected focus integration cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin); assert.equal(page.status, 200);
  const html = await page.text(); const script = html.match(/<script[^>]+src="([^"]+)"/);
  const bundle = await fetch(new URL(script[1], origin)); const code = await bundle.text();
  assert.ok(code.includes('/focus') && code.includes('开始专注'), 'build must include focus controls and adapter');
  const read = async () => parseDailyOverviewText(await (await fetch(origin + '/api/v1/daily-overview')).text());
  const idle = await read();
  const startedResponse = await fetch(origin + '/api/v1/daily-overview/focus', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: idle.revision, action: 'start', task_id: focus.task_id }),
  });
  assert.equal(startedResponse.status, 200);
  const started = parseDailyOverviewText(await startedResponse.text());
  assert.deepEqual(started.focus, focus); assert.deepEqual(await read(), started);
  const persisted = await readFile(dataPath);
  now = Date.parse(focus.ends_at);
  const expired = await read(); assert.equal(expired.focus, null);
  assert.notEqual(expired.revision, started.revision); assert.deepEqual(expired.tasks, started.tasks);
  assert.deepEqual(await readFile(dataPath), persisted);
});

test('built Dashboard and task API share one service; file edits publish new snapshots', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-live-integration-'));
  const sourcePath = path.join(directory, 'tasks.json');
  const fixture = JSON.parse(await readFile(path.join(root, 'contracts/fixtures/device-demo.json'), 'utf8'));
  const source = { date: fixture.date, timezone: fixture.timezone, tasks: fixture.tasks };
  await writeFile(sourcePath, JSON.stringify(source));
  const server = createDemoServer({ dataPath: sourcePath, distPath: path.join(root, 'frontend/dist') });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('focusdesk-live-integration-')) {
      throw new Error('Refusing unexpected integration cleanup target');
    }
    await rm(target, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200, 'run npm run build before this integration check');
  const html = await page.text();
  assert.match(html, /FocusDesk/);
  const script = html.match(/<script[^>]+src="([^"]+)"/);
  assert.ok(script, 'built Dashboard must reference its JavaScript bundle');
  const bundle = await fetch(new URL(script[1], origin));
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type'), /javascript/);
  const code = await bundle.text();
  assert.ok(code.includes('/connect') && code.includes('连接设备'), 'built UI must include the local device connection entry');
  assert.ok(code.includes('/api/v1/daily-overview') && code.includes('/ai-suggestion') && code.includes('保存建议') && code.includes('保存更改'), 'built Hub must include the real task and suggestion read/write controls');

  const read = async () => {
    const response = await fetch(`${origin}/api/v1/daily-overview`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)));
    return parseDailyOverviewText(body);
  };
  const first = await read();
  assert.deepEqual(first.tasks, fixture.tasks);
  assert.equal((await read()).revision, first.revision);
  source.tasks[0].title = 'Task B from your computer';
  await writeFile(sourcePath, JSON.stringify(source));
  const second = await read();
  assert.equal(second.tasks[0].title, source.tasks[0].title);
  assert.notEqual(second.revision, first.revision);
  await writeFile(sourcePath, JSON.stringify({ ...source, tasks: [] }));
  assert.deepEqual((await read()).tasks, []);
  await writeFile(sourcePath, '{');
  const invalid = await fetch(`${origin}/api/v1/daily-overview`);
  assert.equal(invalid.status, 503);
  assert.ok((await invalid.json()).error.code);
  await writeFile(sourcePath, JSON.stringify(source));
  assert.equal((await read()).revision, second.revision);
});

test('browser-origin save persists tasks and exposes the same 1.0 snapshot to device GET', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-live-integration-'));
  const sourcePath = path.join(directory, 'tasks.json');
  await writeFile(sourcePath, JSON.stringify({ date: '2026-11-03', timezone: 'Asia/Shanghai', tasks: [] }));
  const server = createDemoServer({ dataPath: sourcePath, distPath: path.join(root, 'frontend/dist') });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('focusdesk-live-integration-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const initialResponse = await fetch(origin + '/api/v1/daily-overview');
  const initial = parseDailyOverviewText(await initialResponse.text());
  const tasks = [{ id: 'web-task', title: 'Saved in Dashboard', status: 'done', due_at: null }];
  const savedResponse = await fetch(origin + '/api/v1/daily-overview/tasks', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ revision: initial.revision, tasks }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = parseDailyOverviewText(await savedResponse.text());
  const deviceResponse = await fetch(origin + '/api/v1/daily-overview');
  assert.deepEqual(parseDailyOverviewText(await deviceResponse.text()), saved);
  assert.equal(saved.schema_version, '1.0'); assert.equal(saved.date, initial.date);
  assert.deepEqual(saved.tasks, tasks); assert.notEqual(saved.revision, initial.revision);
  assert.deepEqual((await createOverviewLoader(sourcePath).load()).tasks, tasks);
});
