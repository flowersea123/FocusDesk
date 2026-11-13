import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageLan } from '../../scripts/package-lan.mjs';
import { getServerInfo } from '../../backend/src/network-info.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function freePort() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  if (child.connected) child.send({ type: 'focusdesk-stop' }); else child.kill();
  let timer;
  try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Launcher failed to stop')), 5000); })]); }
  catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
}
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'FocusDesk LAN 迁移 '));
  const output = path.join(directory, '移动后的服务 with spaces');
  const children = [];
  t.after(async () => {
    for (const child of children) await stop(child);
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith('FocusDesk LAN 迁移 '));
    await rm(target, { recursive: true, force: true });
  });
  await packageLan({ projectRoot: root, output });
  const port = await freePort();
  await writeFile(path.join(output, 'focusdesk.config.json'), JSON.stringify({ host: '0.0.0.0', port }));
  function launch() {
    const child = fork(path.join(output, 'scripts/start-focusdesk.mjs'), [], {
      cwd: directory, silent: true, execArgv: [], env: { ...process.env, NODE_PATH: '' },
    });
    children.push(child); let log = '';
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Start timeout: ' + log)), 8000);
      child.on('message', message => {
        if (message.type === 'focusdesk-ready') { clearTimeout(timer); resolve(message); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(Error('Early exit ' + code + ': ' + log)); });
      child.once('error', reject);
    });
    return { child, ready, log: () => log };
  }
  return { directory, output, port, launch };
}

test('real portable launcher works from an unrelated cwd and preserves local task/focus writes and LAN read-only access', async t => {
  const { output, port, launch } = await setup(t); const running = launch();
  const ready = await running.ready;
  const origin = `http://127.0.0.1:${port}`; assert.equal(ready.connectionUrl, origin + '/connect');
  const infoResponse = await fetch(origin + '/api/v1/server-info'); const info = await infoResponse.json();
  assert.equal(info.port, port); assert.equal(info.listen_host, '0.0.0.0');
  assert.equal(info.local_url, origin + '/'); assert.equal(infoResponse.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(info), /dataPath|distPath|private_config|\.json|[A-Z]:\\/);
  const page = await fetch(origin + '/connect'); assert.equal(page.status, 200); assert.match(await page.text(), /FOCUSDESK_API_URL/);
  const head = await fetch(origin + '/connect', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(origin)).status, 200);
  const read = async () => (await fetch(origin + '/api/v1/daily-overview')).json();
  const initial = await read();
  const put = (resource, input, headers = {}) => fetch(origin + '/api/v1/daily-overview/' + resource, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  const tasks = [{ ...initial.tasks[0], title: 'Saved in moved Windows folder' }];
  const savedResponse = await put('tasks', { revision: initial.revision, tasks }); assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  const focusResponse = await put('focus', { revision: saved.revision, action: 'start', task_id: tasks[0].id }); assert.equal(focusResponse.status, 200);
  const active = await focusResponse.json(); assert.ok(active.focus);
  for (const [resource, input] of [['tasks', { revision: active.revision, tasks: [] }], ['focus', { revision: active.revision, action: 'stop' }]]) {
    const response = await put(resource, input, { Host: `192.168.1.10:${port}`, Origin: `http://192.168.1.10:${port}` });
    assert.equal(response.status, 403);
  }
  const lan = getServerInfo('0.0.0.0', port).addresses[0];
  if (lan) {
    assert.equal((await fetch(lan.dashboard_url)).status, 200);
    assert.deepEqual(await (await fetch(lan.device_api_url)).json(), active);
    const lanWrite = await fetch(lan.device_api_url + '/focus', { method: 'PUT', headers: { Origin: new URL(lan.dashboard_url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: active.revision, action: 'stop' }) });
    assert.equal(lanWrite.status, 403);
  } else t.diagnostic('No LAN adapter on test host; real LAN HTTP check omitted, binding/filter/policy tests still apply.');
  assert.deepEqual(await read(), active);
  await stop(running.child);
  const second = launch(); await second.ready;
  assert.deepEqual(await read(), active);
  const stopped = await put('focus', { revision: active.revision, action: 'stop' }); assert.equal(stopped.status, 200);
  const idle = await stopped.json(); assert.equal(idle.focus, null); assert.deepEqual(idle.tasks, tasks);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'backend/data/tasks.json'), 'utf8')).tasks, tasks);
  await stop(second.child);
  await assert.rejects(fetch(origin + '/api/v1/server-info'));
});

test('real portable launcher reports port conflicts and invalid configuration without changing task data', async t => {
  const { output, port, launch } = await setup(t); const running = launch(); await running.ready;
  const original = await readFile(path.join(output, 'backend/data/tasks.json'));
  const duplicate = launch(); const failure = duplicate.ready.catch(error => error);
  const [code] = await once(duplicate.child, 'exit'); assert.equal(code, 1); await failure;
  assert.match(duplicate.log(), /already in use/); assert.match(duplicate.log(), new RegExp(String(port)));
  await stop(running.child);
  await writeFile(path.join(output, 'focusdesk.config.json'), '{invalid');
  const invalid = launch(); const invalidReady = invalid.ready.catch(error => error);
  const [invalidCode] = await once(invalid.child, 'exit'); assert.equal(invalidCode, 1); await invalidReady;
  assert.match(invalid.log(), /focusdesk\.config\.json/);
  assert.deepEqual(await readFile(path.join(output, 'backend/data/tasks.json')), original);
});
