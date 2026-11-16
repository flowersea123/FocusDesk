import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDesktopData, validateDesktopSource } from '../src/desktop-data.ts';
import { loadRuntimeOptions } from '../src/runtime-options.ts';
import { createOverviewLoader } from '../src/overview-loader.ts';

const task = { id: 'first', title: 'Imported task', status: 'todo', due_at: null };
const source = { date: '2026-11-03', timezone: 'UTC', tasks: [task] };
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'focusdesk-desktop-data-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('focusdesk-desktop-data-'));
    await rm(root, { recursive: true, force: true });
  });
  const paths = await ensureDesktopData(root);
  return { root, ...paths };
}

test('desktop initializes external empty tasks, config, logs, and backups once', async t => {
  const paths = await setup(t);
  const data = JSON.parse(await readFile(paths.dataPath, 'utf8'));
  assert.deepEqual(data.tasks, []); assert.equal(data.timezone, 'Asia/Shanghai');
  assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(JSON.parse(await readFile(paths.configPath, 'utf8')), { host: '0.0.0.0', port: 8787 });
  assert.ok((await stat(paths.logsPath)).isDirectory());
  assert.ok((await stat(paths.backupsPath)).isDirectory());
  const raw = JSON.stringify(source, null, 3) + '\n';
  await writeFile(paths.dataPath, raw);
  await writeFile(paths.configPath, '{"host":"127.0.0.1","port":9456}');
  const before = await stat(paths.dataPath);
  await ensureDesktopData(paths.root);
  assert.equal(await readFile(paths.dataPath, 'utf8'), raw);
  assert.equal((await stat(paths.dataPath)).mtimeMs, before.mtimeMs);
  assert.equal(JSON.parse(await readFile(paths.configPath, 'utf8')).port, 9456);
});

test('existing invalid files are not replaced by defaults', async t => {
  const paths = await setup(t);
  await writeFile(paths.dataPath, '{broken');
  await assert.rejects(ensureDesktopData(paths.root));
  assert.equal(await readFile(paths.dataPath, 'utf8'), '{broken');
  await writeFile(paths.dataPath, JSON.stringify(source));
  await writeFile(paths.configPath, '{"host":"999.1.1.1","port":8787}');
  await assert.rejects(ensureDesktopData(paths.root));
  assert.equal(await readFile(paths.configPath, 'utf8'), '{"host":"999.1.1.1","port":8787}');
});

test('external config supports CLI precedence and rejects explicitly missing or malformed files', async t => {
  const paths = await setup(t);
  const options = await loadRuntimeOptions(paths.root, ['--config', paths.configPath, '--host', '127.0.0.1', '--port', '9123', '--data', paths.dataPath]);
  assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 9123); assert.equal(options.dataPath, paths.dataPath);
  assert.equal(options.configPath, paths.configPath);
  const defaults = await loadRuntimeOptions(paths.root, []);
  assert.equal(defaults.host, '0.0.0.0'); assert.equal(defaults.port, 8787);
  assert.equal(defaults.dataPath, path.join(paths.root, 'backend', 'data', 'tasks.json'));
  await assert.rejects(loadRuntimeOptions(paths.root, ['--config', path.join(paths.root, 'missing.json')]));
  await assert.rejects(loadRuntimeOptions(paths.root, ['--config']));
  await writeFile(paths.configPath, '{broken');
  await assert.rejects(loadRuntimeOptions(paths.root, ['--config', paths.configPath]));
});

test('source validation rejects wrong format, device profile, byte limit, and invalid focus', () => {
  for (const bad of [null, [], { ...source, unknown: true }, { ...source, date: '2026-02-30' },
    { ...source, timezone: 'Europe/London' }, { ...source, tasks: [{ ...task, device_title: '中文' }] },
    ' '.repeat(4097), { ...source, focus: { task_id: task.id, started_at: 'bad', ends_at: 'bad' } }]) {
    assert.throws(() => validateDesktopSource(bad), error => error.code === 'IMPORT_INVALID_SOURCE');
  }
});

test('confirmed import preserves source metadata and backs up exact previous raw bytes', async t => {
  const paths = await setup(t);
  const original = await readFile(paths.dataPath);
  const store = createOverviewLoader(paths.dataPath);
  const current = await store.load();
  const saved = await store.importSource(source, { revision: current.revision, confirmed: true, backupsPath: paths.backupsPath });
  assert.equal(saved.date, source.date); assert.equal(saved.timezone, source.timezone); assert.deepEqual(saved.tasks, source.tasks);
  assert.deepEqual(JSON.parse(await readFile(paths.dataPath, 'utf8')), source);
  const names = await readdir(paths.backupsPath); assert.equal(names.length, 1);
  assert.deepEqual(await readFile(path.join(paths.backupsPath, names[0])), original);
  assert.deepEqual((await createOverviewLoader(paths.dataPath).load()).tasks, source.tasks);
});

test('unconfirmed, stale, and invalid import never mutate data or create backups', async t => {
  const paths = await setup(t); const raw = await readFile(paths.dataPath);
  const store = createOverviewLoader(paths.dataPath); const current = await store.load();
  await assert.rejects(store.importSource(source, { revision: current.revision, confirmed: false, backupsPath: paths.backupsPath }), error => error.code === 'IMPORT_CONFIRMATION_REQUIRED');
  await assert.rejects(store.importSource(source, { revision: 'stale', confirmed: true, backupsPath: paths.backupsPath }), { name: 'RevisionConflictError' });
  assert.throws(() => store.importSource({ ...source, tasks: [{ ...task, device_title: '中文' }] }, { revision: current.revision, confirmed: true, backupsPath: paths.backupsPath }));
  assert.deepEqual(await readFile(paths.dataPath), raw); assert.deepEqual(await readdir(paths.backupsPath), []);
});

test('expired focus is preserved on disk and naturally excluded from reads', async t => {
  const paths = await setup(t); const store = createOverviewLoader(paths.dataPath);
  const current = await store.load();
  const expired = { ...source, focus: { task_id: task.id, started_at: '2000-01-01T00:00:00.000Z', ends_at: '2000-01-01T00:25:00.000Z' } };
  const saved = await store.importSource(expired, { revision: current.revision, confirmed: true, backupsPath: paths.backupsPath });
  assert.equal(saved.focus, null);
  assert.deepEqual(JSON.parse(await readFile(paths.dataPath, 'utf8')).focus, expired.focus);
});

test('Unicode tasks round-trip through edits, focus, reloading, and desktop source validation', async t => {
  const paths = await setup(t);
  const store = createOverviewLoader(paths.dataPath);
  const initial = await store.load();
  const paper = { id:'new-paper', title:'看论文', device_title:'Read paper', status:'todo', due_at:null };
  const created = await store.update({revision:initial.revision,tasks:[paper]});
  assert.deepEqual(created.tasks,[paper]);
  const started = await store.updateFocus({revision:created.revision,action:'start',task_id:paper.id});
  const renamed = {...paper, title:'读第二章 📖'};
  const changed = await store.update({revision:started.revision,tasks:[renamed]});
  assert.equal(changed.focus?.task_id,paper.id);
  assert.deepEqual(changed.tasks,[renamed]);
  const source = validateDesktopSource(await readFile(paths.dataPath,'utf8'));
  assert.deepEqual(source.tasks,[renamed]);
  assert.deepEqual((await createOverviewLoader(paths.dataPath).load()).tasks,[renamed]);
});

test('active focus survives import without starting a new 25-minute session', async t => {
  const paths = await setup(t); const now = Date.parse('2026-11-03T01:05:00.000Z');
  const store = createOverviewLoader(paths.dataPath, { now: () => now }); const current = await store.load();
  const active = { ...source, focus: { task_id: task.id, started_at: '2026-11-03T01:00:00.000Z', ends_at: '2026-11-03T01:25:00.000Z' } };
  const saved = await store.importSource(active, { revision: current.revision, confirmed: true, backupsPath: paths.backupsPath });
  assert.deepEqual(saved.focus, active.focus);
});

test('backup failure preserves original data and cleans the prepared temporary source', async t => {
  const paths = await setup(t); const raw = await readFile(paths.dataPath);
  const blocker = path.join(paths.root, 'not-a-directory'); await writeFile(blocker, 'block');
  const store = createOverviewLoader(paths.dataPath); const current = await store.load();
  await assert.rejects(store.importSource(source, { revision: current.revision, confirmed: true, backupsPath: blocker }), error => error.code === 'TASK_SOURCE_WRITE_FAILED');
  assert.deepEqual(await readFile(paths.dataPath), raw);
  assert.equal((await readdir(path.dirname(paths.dataPath))).some(name => name.endsWith('.tmp')), false);
});

test('failed rename retains raw backup and old source while removing only its own temp', async t => {
  const paths = await setup(t); const raw = await readFile(paths.dataPath);
  const store = createOverviewLoader(paths.dataPath, { replace: async () => { throw Error('simulated replacement failure'); } });
  const current = await store.load();
  await assert.rejects(store.importSource(source, { revision: current.revision, confirmed: true, backupsPath: paths.backupsPath }), error => error.code === 'TASK_SOURCE_WRITE_FAILED');
  assert.deepEqual(await readFile(paths.dataPath), raw);
  const names = await readdir(paths.backupsPath); assert.equal(names.length, 1);
  assert.deepEqual(await readFile(path.join(paths.backupsPath, names[0])), raw);
  assert.equal((await readdir(path.dirname(paths.dataPath))).some(name => name.endsWith('.tmp')), false);
});

test('imports share the ordinary update queue and reject a concurrent stale base', async t => {
  const paths = await setup(t); const store = createOverviewLoader(paths.dataPath); const current = await store.load();
  const outcomes = await Promise.allSettled([
    store.update({ revision: current.revision, tasks: [{ ...task, title: 'Web edit wins' }] }),
    store.importSource(source, { revision: current.revision, confirmed: true, backupsPath: paths.backupsPath }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes[1].status, 'rejected'); assert.equal(outcomes[1].reason.name, 'RevisionConflictError');
  assert.deepEqual(await readdir(paths.backupsPath), []);
});

test('closing waits for accepted writes and prevents later queue additions', async t => {
  const paths = await setup(t);
  let started, proceed;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  const { rename } = await import('node:fs/promises');
  const store = createOverviewLoader(paths.dataPath, { replace: async (...args) => { started(); await gate; await rename(...args); } });
  const current = await store.load();
  const pending = store.update({ revision: current.revision, tasks: [task] });
  await entered; let closed = false; const closing = store.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(store.load(), error => error.code === 'SERVICE_STOPPING');
  proceed(); await pending; await closing; assert.equal(closed, true);
  assert.deepEqual((await createOverviewLoader(paths.dataPath).load()).tasks, [task]);
});
