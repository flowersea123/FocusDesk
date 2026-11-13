import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDesktopData } from '../src/desktop-data.ts';
import { acquireDataLock } from '../src/data-lock.ts';

const entry = fileURLToPath(new URL('../server.ts', import.meta.url));
const source = { date: '2026-11-03', timezone: 'UTC', tasks: [{ id: 'imported', title: 'Imported on desktop', status: 'todo', due_at: null }] };

async function freePort() {
  const owner = createServer(); owner.listen(0, '127.0.0.1'); await once(owner, 'listening');
  const port = owner.address().port; await new Promise(resolve => owner.close(resolve)); return port;
}
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'focusdesk-desktop-server-'));
  const paths = await ensureDesktopData(root); const children = [];
  const port = await freePort(); await writeFile(paths.configPath, JSON.stringify({ host: '127.0.0.1', port }));
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      if (child.connected) child.send({ type: 'focusdesk-stop' }); else child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 4000);
      try { await exited; } finally { clearTimeout(force); }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('focusdesk-desktop-server-'));
    await rm(root, { recursive: true, force: true });
  });
  function launch(extra = []) {
    const child = fork(entry, ['--config', paths.configPath, '--data', paths.dataPath, '--dist', root, ...extra], { cwd: root, silent: true, execArgv: [] });
    children.push(child); const messages = []; let output = '';
    child.on('message', value => messages.push(value));
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    async function wait(predicate) {
      const previous = messages.find(predicate); if (previous) return previous;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(Error('IPC timeout: ' + output)); }, 5000);
        const message = value => { if (predicate(value)) { cleanup(); resolve(value); } };
        const exit = code => { cleanup(); reject(Error('Early exit ' + code + ': ' + output)); };
        function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
        child.on('message', message); child.once('exit', exit);
      });
    }
    return { child, wait, messages, output: () => output };
  }
  return { ...paths, root, port, launch };
}

test('CLI IPC previews without writing, requires confirmation, then backs up and imports', async t => {
  const paths = await setup(t); const running = paths.launch();
  const ready = await running.wait(message => message.type === 'focusdesk-ready');
  assert.equal(ready.dashboardUrl, `http://127.0.0.1:${paths.port}/`);
  assert.equal(ready.dataPath, paths.dataPath);
  const original = await readFile(paths.dataPath);
  running.child.send({ type: 'focusdesk-import-preview', requestId: 'preview-1', source });
  const preview = await running.wait(message => message.requestId === 'preview-1');
  assert.equal(preview.type, 'focusdesk-import-preview'); assert.equal(preview.exists, true);
  assert.equal(preview.taskCount, 1); assert.equal(preview.focusActive, false); assert.equal(preview.ok, true);
  assert.deepEqual(await readFile(paths.dataPath), original); assert.deepEqual(await readdir(paths.backupsPath), []);
  running.child.send({ type: 'focusdesk-import-commit', requestId: 'unconfirmed', source, revision: preview.revision, confirmed: false, backupsPath: paths.backupsPath });
  assert.equal((await running.wait(message => message.requestId === 'unconfirmed')).code, 'IMPORT_CONFIRMATION_REQUIRED');
  running.child.send({ type: 'focusdesk-import-commit', requestId: 'commit', source, revision: preview.revision, confirmed: true, backupsPath: paths.backupsPath });
  const result = await running.wait(message => message.requestId === 'commit');
  assert.equal(result.type, 'focusdesk-import-result'); assert.equal(result.ok, true); assert.equal(result.code, 'IMPORT_OK');
  assert.deepEqual(JSON.parse(await readFile(paths.dataPath, 'utf8')), source);
  const files = await readdir(paths.backupsPath); assert.equal(files.length, 1);
  assert.deepEqual(await readFile(path.join(paths.backupsPath, files[0])), original);
  const response = await fetch(ready.dashboardUrl + 'api/v1/daily-overview'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tasks, source.tasks);
  running.child.send({ type: 'focusdesk-import-commit', requestId: 'stale', source: { ...source, tasks: [] }, revision: preview.revision, confirmed: true, backupsPath: paths.backupsPath });
  assert.equal((await running.wait(message => message.requestId === 'stale')).code, 'IMPORT_REVISION_CONFLICT');
  const ended = once(running.child, 'exit'); running.child.send({ type: 'focusdesk-stop' }); assert.equal((await ended)[0], 0);
  const lock = await acquireDataLock(paths.dataPath); await lock.release();
});

test('different TCP ports cannot bypass the canonical data lock', async t => {
  const paths = await setup(t); const first = paths.launch(); await first.wait(message => message.type === 'focusdesk-ready');
  const otherPort = await freePort(); const second = paths.launch(['--port', String(otherPort)]);
  const exited = once(second.child, 'exit'); const error = await second.wait(message => message.type === 'focusdesk-error');
  assert.equal(error.code, 'DATA_LOCKED'); assert.equal((await exited)[0], 1);
  assert.match(second.output(), /already in use/); assert.match(second.output(), new RegExp(String(otherPort)));
  assert.equal((await fetch(`http://127.0.0.1:${paths.port}/api/v1/daily-overview`)).status, 200);
});

test('invalid explicit config reports only a safe IPC error code and does not touch data', async t => {
  const paths = await setup(t); const raw = await readFile(paths.dataPath); await writeFile(paths.configPath, '{invalid');
  const running = paths.launch(); const exited = once(running.child, 'exit');
  const error = await running.wait(message => message.type === 'focusdesk-error');
  assert.deepEqual(error, { type: 'focusdesk-error', code: 'CONFIG_INVALID' }); assert.equal((await exited)[0], 1);
  assert.deepEqual(await readFile(paths.dataPath), raw);
});

test('host disconnect during startup cannot leave an orphan service or data lock', async t => {
  const paths = await setup(t); const running = paths.launch();
  const exited = once(running.child, 'exit');
  running.child.disconnect();
  assert.equal((await exited)[0], 0);
  const lock = await acquireDataLock(paths.dataPath); await lock.release();
});
