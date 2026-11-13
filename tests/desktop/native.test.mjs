import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, cp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME = path.join(ROOT, '.cache/m1-toolchain/node-v24.16.0-win-x64/node.exe');
const NATIVE = path.join(ROOT, '.cache/m1-native/launcher/FocusDesk.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await pause(100); }
  throw Error('Native lifecycle condition timed out');
}
async function freePort() {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function setup(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'FocusDesk native 测试 '));
  const app = path.join(base, 'program with spaces'), user = path.join(base, 'profile'); const children = [];
  t.after(async () => {
    await command('--shutdown').catch(() => {});
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('FocusDesk native 测试 '));
    await rm(base, { recursive: true, force: true });
  });
  for (const directory of ['backend/src', 'backend/public', 'frontend/dist']) await cp(path.join(ROOT, directory), path.join(app, directory), { recursive: true });
  for (const file of ['backend/server.ts', 'package.json', 'contracts/daily-overview.ts', 'contracts/task-update.ts', 'contracts/focus-update.ts',
    'contracts/work-state.ts', 'contracts/ai-suggestion.ts', 'contracts/display-snapshot.ts', 'contracts/display-fonts.ts', 'contracts/DISPLAY_FONT_LICENSE.txt',
    'scripts/desktop-host.mjs', 'scripts/desktop-logs.mjs', 'scripts/desktop-paths.mjs', 'scripts/import-client.mjs']) {
    await mkdir(path.dirname(path.join(app, file)), { recursive: true }); await copyFile(path.join(ROOT, file), path.join(app, file));
  }
  await mkdir(path.join(app, 'runtime'), { recursive: true }); await copyFile(RUNTIME, path.join(app, 'runtime/node.exe'));
  await mkdir(path.join(app, 'launcher'), { recursive: true }); const executable = path.join(app, 'launcher/FocusDesk.exe'); await copyFile(NATIVE, executable);
  await mkdir(path.join(user, 'config'), { recursive: true }); const port = await freePort();
  await writeFile(path.join(user, 'config/focusdesk.config.json'), JSON.stringify({ host: '0.0.0.0', port }));
  function launch(extra = []) {
    const child = spawn(executable, ['--test-mode', '--user-data-dir', user, ...extra], { windowsHide: true, cwd: base, env: { ...process.env, PATH: '', NODE_PATH: '' }, stdio: 'ignore' });
    children.push(child); return child;
  }
  async function command(...args) { const child = launch(args); return (await once(child, 'exit'))[0]; }
  const state = async () => JSON.parse(await readFile(path.join(user, 'logs/test-state.json'), 'utf8'));
  return { app, user, port, launch, command, state };
}

test('native tray actions, duplicate launch and graceful exit work without a system Node PATH', async t => {
  const { user, port, launch, command, state } = await setup(t); const first = launch();
  const initial = await waitFor(async () => { const value = await state(); return value.phase === 'ready' && value; });
  assert.equal(initial.pid, first.pid); assert.equal(initial.port, port);
  const origin = `http://127.0.0.1:${port}`; assert.equal((await fetch(origin)).status, 200);
  const duplicate = launch(); assert.equal((await once(duplicate, 'exit'))[0], 0);
  assert.equal((await state()).pid, first.pid);
  for (const action of ['dashboard', 'connect', 'logs']) assert.equal(await command('--command', action), 0);
  const log = await readFile(path.join(user, 'logs/launcher.log'), 'utf8');
  for (const event of ['OPEN_DASHBOARD', 'OPEN_CONNECTION', 'OPEN_LOGS']) assert.match(log, new RegExp(event));
  assert.equal(first.exitCode, null, 'opening/closing independent pages must not stop backend');
  const exit = once(first, 'exit'); assert.equal(await command('--command', 'exit'), 0); assert.equal((await exit)[0], 0);
  assert.equal((await state()).phase, 'stopped'); await assert.rejects(fetch(origin));
  assert.equal(await command('--shutdown'), 0, 'shutdown when not running is idempotent');
});

test('native Job Object recovers backend and data lock when launcher is forcibly terminated', async t => {
  const { port, launch, state, command } = await setup(t); const first = launch();
  await waitFor(async () => (await state()).phase === 'ready');
  const exit = once(first, 'exit'); first.kill(); await exit;
  await waitFor(async () => { try { await fetch(`http://127.0.0.1:${port}/`); return false; } catch { return true; } });
  const next = launch();
  await waitFor(async () => { const value = await state(); return value.pid === next.pid && value.phase === 'ready'; });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/daily-overview`)).status, 200);
  const stopped = once(next, 'exit'); assert.equal(await command('--shutdown'), 0); assert.equal((await stopped)[0], 0);
});
