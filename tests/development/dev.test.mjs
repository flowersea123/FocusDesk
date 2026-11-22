import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevelopmentData, startDevelopment } from '../../scripts/dev.mjs';
import { acquireDataLock } from '../../backend/src/data-lock.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'FocusDesk Mac development '));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  if (child.connected) child.send({ type: 'focusdesk-stop' }); else child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { await ended; } finally { clearTimeout(force); }
}
function launch(t, directory, args) {
  const child = fork(path.join(root, 'scripts/dev.mjs'), args, { cwd: directory, silent: true, execArgv: [],
    env: { ...process.env, FOCUSDESK_DEV_CACHE_DIR: path.join(directory, 'vite-cache') } });
  t.after(async () => { await stop(child); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(Error('Development startup timeout: ' + output)), 20_000);
    const message = value => { if (value?.type === 'focusdesk-dev-ready') finish(null, value); };
    const exit = code => finish(Error(`Development exited ${code}: ${output}`));
    const error = failure => finish(failure);
    function finish(failure, value) {
      clearTimeout(timeout); child.off('message', message); child.off('exit', exit); child.off('error', error);
      if (failure) reject(failure); else resolve(value);
    }
    child.on('message', message); child.once('exit', exit); child.once('error', error);
  });
  return { child, ready, output: () => output };
}

test('development seeds only a missing file and never replaces existing or invalid data', async t => {
  const directory = await temporary(t);
  const dataPath = path.join(directory, 'tasks.json');
  await prepareDevelopmentData(root, dataPath);
  const source = JSON.parse(await readFile(dataPath, 'utf8'));
  source.tasks = [];
  const original = JSON.stringify(source);
  await writeFile(dataPath, original);
  await prepareDevelopmentData(root, dataPath);
  assert.equal(await readFile(dataPath, 'utf8'), original);
  await writeFile(dataPath, '{invalid-but-preserved');
  await assert.rejects(prepareDevelopmentData(root, dataPath));
  assert.equal(await readFile(dataPath, 'utf8'), '{invalid-but-preserved');
});

test('real development launcher serves both pages, proxies local saves to the real Hub, and closes both services', async t => {
  const directory = await temporary(t);
  const dataPath = path.join(directory, 'editable tasks.json');
  const port = await freePort(), uiPort = await freePort();
  const running = launch(t, directory, ['--port', String(port), '--ui-port', String(uiPort), '--data', dataPath, '--no-watch']);
  const ready = await running.ready;
  const origin = new URL(ready.dashboardUrl).origin;
  assert.equal(origin, `http://127.0.0.1:${uiPort}`);
  assert.equal(ready.backendUrl, `http://127.0.0.1:${port}`);
  for (const page of ['/', '/simulator']) {
    const response = await fetch(origin + page);
    assert.equal(response.status, 200); assert.match(await response.text(), /src\/main\.tsx/);
  }
  const initial = await (await fetch(origin + '/api/v1/daily-overview')).json();
  const tasks = [{ id: 'mac-test', title: 'Saved from Mac development', status: 'todo', due_at: null }];
  const savedResponse = await fetch(origin + '/api/v1/daily-overview/tasks', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: initial.revision, tasks }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.deepEqual((await (await fetch(ready.backendUrl + '/api/v1/daily-overview')).json()).tasks, tasks);
  const snapshot = await (await fetch(origin + '/api/v1/display-snapshot')).json();
  assert.equal(snapshot.width, 400); assert.equal(snapshot.height, 300);
  assert.ok(snapshot.revision.endsWith(saved.revision));
  assert.ok(snapshot.commands.some(command => command[0] === 1 && command[5] === tasks[0].title));
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).tasks, tasks);
  const forbidden = await fetch(origin + '/api/v1/daily-overview/tasks', {
    method: 'PUT', headers: { Origin: 'http://unrelated.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: saved.revision, tasks: [] }),
  });
  assert.equal(forbidden.status, 403);
  await stop(running.child);
  assert.equal(running.child.exitCode, 0, running.output());
  await assert.rejects(fetch(origin + '/api/v1/server-info'));
  await assert.rejects(fetch(ready.backendUrl + '/api/v1/server-info'));
  const lock = await acquireDataLock(dataPath); await lock.release();
});

test('an occupied development UI port leaves the other service alone and releases the newly started Hub', async t => {
  const directory = await temporary(t);
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(async () => { await new Promise(resolve => occupied.close(resolve)); });
  const uiPort = occupied.address().port, port = await freePort();
  const dataPath = path.join(directory, 'tasks.json');
  const running = launch(t, directory, ['--port', String(port), '--ui-port', String(uiPort), '--data', dataPath, '--no-watch']);
  const ended = once(running.child, 'exit');
  await assert.rejects(running.ready, /already in use/);
  assert.equal((await ended)[0], 1);
  assert.ok(occupied.listening);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/server-info`));
  const lock = await acquireDataLock(dataPath); await lock.release();
});

test('closing during the first cold browser module requests does not strand the development process', async t => {
  const directory = await temporary(t);
  const dataPath = path.join(directory, 'cold start.json');
  const running = launch(t, directory, ['--port', String(await freePort()), '--ui-port', String(await freePort()), '--data', dataPath, '--no-watch']);
  const ready = await running.ready;
  const source = await (await fetch(ready.dashboardUrl + 'src/main.tsx')).text();
  const imports = [...source.matchAll(/from\s+"([^"]+\/deps\/[^"?]+\.js[^\"]*)"/g)].map(match => match[1]);
  assert.ok(imports.length >= 2, 'Exercise real optimized React imports before shutting down.');
  const requests = imports.map(url => fetch(new URL(url, ready.dashboardUrl), { signal: AbortSignal.timeout(3000) })
    .then(response => response.arrayBuffer()).catch(() => undefined));
  await new Promise(resolve => setTimeout(resolve, 10));
  await stop(running.child);
  await Promise.all(requests);
  assert.equal(running.child.exitCode, 0, running.output());
  await assert.rejects(fetch(ready.backendUrl + '/api/v1/server-info'));
  const lock = await acquireDataLock(dataPath); await lock.release();
});

test('editing copied shared layout source restarts the real Hub without changing saved tasks', async t => {
  const directory = await temporary(t);
  const checkout = path.join(directory, 'watch checkout');
  await mkdir(checkout);
  for (const name of ['backend', 'contracts']) {
    await cp(path.join(root, name), path.join(checkout, name), { recursive: true,
      filter: source => !source.includes(`${path.sep}tests${path.sep}`) && !source.endsWith('tasks.json') && !source.endsWith('.lock') });
  }
  await symlink(path.join(root, 'frontend'), path.join(checkout, 'frontend'), process.platform === 'win32' ? 'junction' : 'dir');
  const dataPath = path.join(directory, 'watch tasks.json');
  const running = await startDevelopment({ root: checkout, port: await freePort(), uiPort: await freePort(), dataPath });
  t.after(async () => { await running.close(); });
  const original = await readFile(dataPath, 'utf8');
  const layoutPath = path.join(checkout, 'contracts/display-snapshot.ts');
  const layout = await readFile(layoutPath, 'utf8');
  assert.ok(layout.includes('goal-1:nun1:'));
  await writeFile(layoutPath, layout.replace('goal-1:nun1:', 'goal-1:watch-test:'));
  const deadline = Date.now() + 10_000;
  let revision = '';
  while (Date.now() < deadline) {
    try { revision = (await (await fetch(running.backendUrl + '/api/v1/display-snapshot')).json()).revision ?? ''; }
    catch { /* A brief refused connection is expected during the restart. */ }
    if (revision.startsWith('goal-1:watch-test:')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(revision.startsWith('goal-1:watch-test:'), 'The Hub must reload the changed layout source.');
  assert.equal(await readFile(dataPath, 'utf8'), original);
  await running.close();
});
