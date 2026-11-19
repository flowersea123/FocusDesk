import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectPayloadSources } from '../../scripts/build-installer.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Exercise the JavaScript supervisor with this platform's Node 24 in the bundle layout.
// Windows always uses the pinned release runtime, including its empty-PATH checks.
const RUNTIME = process.platform === 'win32' ? path.join(ROOT, '.cache/m1-toolchain/node-v24.16.0-win-x64/node.exe') : process.execPath;
async function availablePort() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function setup(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'FocusDesk desktop 用户 '));
  const app = path.join(base, 'Program Files app'), user = path.join(base, 'user data'); let running;
  t.after(async () => {
    if (running?.child.exitCode === null) {
      running.child.stdin.end('STOP\n');
      await running.exited;
    }
    assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('FocusDesk desktop 用户 '));
    await rm(base, { recursive: true, force: true });
  });
  for (const relative of ['package.json', ...await collectPayloadSources(ROOT)]) {
    await mkdir(path.dirname(path.join(app, relative)), { recursive: true }); await copyFile(path.join(ROOT, relative), path.join(app, relative));
  }
  await mkdir(path.join(app, 'runtime'), { recursive: true }); await copyFile(RUNTIME, path.join(app, 'runtime/node.exe'));
  await mkdir(path.join(user, 'config'), { recursive: true }); const port = await availablePort();
  await writeFile(path.join(user, 'config/focusdesk.config.json'), JSON.stringify({ host: '0.0.0.0', port }));
  function launch() {
    const child = spawn(path.join(app, 'runtime/node.exe'), [path.join(app, 'scripts/desktop-host.mjs'), '--user-data-dir', user], {
      cwd: base, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: '', NODE_PATH: '' },
    });
    let output = '', errors = ''; const listeners = [];
    child.stdout.on('data', chunk => { output += chunk; for (const callback of [...listeners]) callback(); });
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = once(child, 'exit');
    function line(prefix, timeout = 25000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { remove(); reject(Error('Missing ' + prefix + ': ' + output + errors)); }, timeout);
        const remove = () => { clearTimeout(timer); const at = listeners.indexOf(check); if (at >= 0) listeners.splice(at, 1); };
        const check = () => { const result = output.split('\n').find(value => value.startsWith(prefix)); if (result) { remove(); resolve(result); } };
        listeners.push(check); check();
      });
    }
    running = { child, exited, line, output: () => output, errors: () => errors }; return running;
  }
  return { base, app, user, port, launch };
}

test('bundled host works with empty PATH, imports only after confirmation with backup, and stops all its children', async t => {
  const { base, user, port, launch } = await setup(t); const running = launch();
  assert.equal(await running.line('READY|'), 'READY|' + port);
  const origin = `http://127.0.0.1:${port}`;
  const read = async () => (await fetch(origin + '/api/v1/daily-overview')).json();
  const initial = await read(); assert.deepEqual(initial.tasks, []);
  const tasks = [{ id: 'first', title: 'PRIVATE_FIRST_TASK', status: 'todo', due_at: null }];
  const saved = await (await fetch(origin + '/api/v1/daily-overview/tasks', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: initial.revision, tasks }) })).json();
  assert.deepEqual(saved.tasks, tasks);
  const source = { date: '2026-11-03', timezone: 'UTC', tasks: [{ ...tasks[0], id: 'imported', title: 'PRIVATE_IMPORTED_TASK' }] };
  const filename = path.join(base, '旧版 tasks.json'); await writeFile(filename, JSON.stringify(source));
  running.child.stdin.write('IMPORT\t' + filename + '\n'); await running.line('IMPORT_CONFIRM|');
  assert.deepEqual((await read()).tasks, tasks, 'preview must not write');
  running.child.stdin.write('IMPORT_COMMIT\n'); assert.equal(await running.line('IMPORT_RESULT|'), 'IMPORT_RESULT|OK');
  assert.deepEqual((await read()).tasks, source.tasks);
  const backups = await readdir(path.join(user, 'backups')); assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(user, 'backups', backups[0]), 'utf8')).tasks, tasks);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), source);
  running.child.stdin.end('STOP\n'); const [code] = await running.exited; assert.equal(code, 0);
  await assert.rejects(fetch(origin + '/api/v1/daily-overview'));
  const logs = await readFile(path.join(user, 'logs/focusdesk.log'), 'utf8');
  assert.match(logs, /BACKEND_READY/); assert.match(logs, /APPLICATION_STOPPED/); assert.doesNotMatch(logs, /PRIVATE_|旧版/);
});

test('bundled host reports port conflict and leaves the unknown listener and user data intact', async t => {
  const { port, user, launch } = await setup(t); const occupied = createServer(socket => socket.destroy());
  occupied.listen(port, '127.0.0.1'); await once(occupied, 'listening'); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const running = launch(); assert.equal(await running.line('ERROR|'), 'ERROR|PORT_IN_USE');
  const [code] = await running.exited; assert.equal(code, 1); assert.equal(occupied.listening, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(user, 'data/tasks.json'), 'utf8')).tasks, []);
});

test('invalid pre-existing data is preserved and reported instead of being replaced', async t => {
  const { user, launch } = await setup(t); await mkdir(path.join(user, 'data'), { recursive: true });
  await writeFile(path.join(user, 'data/tasks.json'), '{invalid-existing');
  const running = launch(); assert.equal(await running.line('ERROR|'), 'ERROR|DATA_INVALID');
  assert.equal((await running.exited)[0], 1);
  assert.equal(await readFile(path.join(user, 'data/tasks.json'), 'utf8'), '{invalid-existing');
});

test('startup timeout is explicit and the child is stopped rather than left running', async t => {
  const { app, launch } = await setup(t);
  await writeFile(path.join(app, 'backend/server.ts'), "process.on('message',m=>{if(m.type==='focusdesk-stop') process.disconnect()});\n");
  const running = launch(); assert.equal(await running.line('ERROR|', 24000), 'ERROR|STARTUP_TIMEOUT');
  assert.equal((await running.exited)[0], 1);
});
