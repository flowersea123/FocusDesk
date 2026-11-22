import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rename, stat, rm, mkdir, symlink } from 'node:fs/promises';
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

async function startLockOwner(t, file) {
  const moduleUrl = new URL('../src/data-lock.ts', import.meta.url).href;
  const script = `import { acquireDataLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireDataLock(${JSON.stringify(file)}); process.send({type:'ready'}); process.on('message',async()=>{await lock.release();process.disconnect();});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error('Lock owner startup timed out: ' + errors)); }, 5000);
    function cleanup() { clearTimeout(timer); child.off('message', ready); child.off('error', failed); child.off('exit', exited); }
    function ready(value) { if (value?.type === 'ready') { cleanup(); resolve(); } }
    function failed(error) { cleanup(); reject(error); }
    function exited(code) { cleanup(); reject(Error('Lock owner exited ' + code + ': ' + errors)); }
    child.on('message', ready); child.once('error', failed); child.once('exit', exited);
  });
  return child;
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

test('atomic replacement of task data does not release its lock', async t => {
  const { file } = await setup(t);
  const first = await acquireDataLock(file);
  try {
    await writeFile(file + '.pending', '{"saved":true}');
    await rename(file + '.pending', file);
    await assert.rejects(acquireDataLock(file), error => error.code === 'DATA_LOCKED');
    assert.equal(await readFile(file, 'utf8'), '{"saved":true}');
  } finally { await first.release(); }
  const recovered = await acquireDataLock(file); await recovered.release();
});

test('different task files can be locked independently', async t => {
  const { file } = await setup(t);
  const other = path.join(path.dirname(file), 'other-tasks.json'); await writeFile(other, '{}');
  const first = await acquireDataLock(file);
  try {
    const second = await acquireDataLock(other);
    try {
      await assert.rejects(acquireDataLock(file), error => error.code === 'DATA_LOCKED');
      await assert.rejects(acquireDataLock(other), error => error.code === 'DATA_LOCKED');
    } finally { await second.release(); }
  } finally { await first.release(); }
});

test('simultaneous contenders elect exactly one data owner', async t => {
  const { file } = await setup(t);
  const contenders = await Promise.allSettled(Array.from({ length: 6 }, () => acquireDataLock(file)));
  const owners = contenders.filter(result => result.status === 'fulfilled');
  try {
    assert.equal(owners.length, 1);
    for (const result of contenders.filter(value => value.status === 'rejected')) assert.equal(result.reason.code, 'DATA_LOCKED');
  } finally { await Promise.all(owners.map(result => result.value.release())); }
});

test('macOS keeps a stable unlocked file across successive owners', { skip: process.platform !== 'darwin' }, async t => {
  const { file } = await setup(t);
  const first = await acquireDataLock(file);
  const directory = path.dirname(file);
  const lockFiles = (await readdir(directory)).filter(name => name !== 'tasks.json');
  assert.equal(lockFiles.length, 1);
  const lockFile = path.join(directory, lockFiles[0]);
  const original = await stat(lockFile);
  await first.release();
  assert.equal((await stat(lockFile)).ino, original.ino, 'release must not unlink the inode another process may already have opened');
  const next = await acquireDataLock(file);
  try { assert.equal((await stat(lockFile)).ino, original.ino); }
  finally { await next.release(); }
});

test('OS releases a cross-process lock after abrupt owner death without stale cleanup', async t => {
  const { file } = await setup(t);
  const child = await startLockOwner(t, file);
  await assert.rejects(acquireDataLock(file), error => error.code === 'DATA_LOCKED');
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  const independentOwner = await startLockOwner(t, file);
  await assert.rejects(acquireDataLock(file), error => error.code === 'DATA_LOCKED');
  const released = once(independentOwner, 'exit'); independentOwner.send('release');
  assert.equal((await released)[0], 0);
  const recovered = await acquireDataLock(file); await recovered.release();
});
