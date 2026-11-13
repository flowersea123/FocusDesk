import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireDataLock } from '../src/data-lock.ts';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'focusdesk-desktop-lock-'));
  const file = path.join(root, 'data', 'tasks.json'); await mkdir(path.dirname(file)); await writeFile(file, '{}');
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('focusdesk-desktop-lock-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

test('data lock rejects duplicate ownership independently of a TCP port', async t => {
  const { file } = await setup(t);
  const first = await acquireDataLock(file);
  try { await assert.rejects(acquireDataLock(file), error => error.code === 'DATA_LOCKED'); }
  finally { await first.release(); }
  const next = await acquireDataLock(file); await next.release(); await next.release();
});

test('canonical directory aliases share one data lock', async t => {
  const { root, file } = await setup(t);
  const alias = path.join(root, 'alias'); await symlink(path.dirname(file), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const first = await acquireDataLock(file);
  try { await assert.rejects(acquireDataLock(path.join(alias, 'tasks.json')), error => error.code === 'DATA_LOCKED'); }
  finally { await first.release(); }
});

test('OS releases a cross-process lock after abrupt owner death without stale cleanup', async t => {
  const { file } = await setup(t);
  const moduleUrl = new URL('../src/data-lock.ts', import.meta.url).href;
  const script = `import { acquireDataLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireDataLock(${JSON.stringify(file)}); process.send({type:'ready'}); process.on('message',async()=>{await lock.release();process.disconnect();});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(Error('Lock helper exited ' + code))); });
  await assert.rejects(acquireDataLock(file), error => error.code === 'DATA_LOCKED');
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  const recovered = await acquireDataLock(file); await recovered.release();
});
