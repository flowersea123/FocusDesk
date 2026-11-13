import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOverviewLoader, RevisionConflictError } from '../src/overview-loader.ts';
import { createDemoServer } from '../src/service.ts';
import { validateDesktopSource } from '../src/desktop-data.ts';

const seed = { date: '2026-11-12', timezone: 'UTC', tasks: [{ id: 'draft', title: 'Write outline', status: 'todo', due_at: null }] };
const work = { goal: 'Submit the draft', current_action: 'Write outline', next_action: 'Review draft' };
const signal = { id: 'manual', content: 'Review ready', source: 'Manual', created_at: '2026-11-12T10:00:00.000Z', priority: 'normal', status: 'active' };
const now = () => Date.parse('2026-11-12T10:00:00.000Z');

async function setup(t, source = seed, persistence = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'focusdesk-ai-'));
  const dataPath = path.join(directory, 'tasks.json');
  await writeFile(dataPath, JSON.stringify(source));
  const loader = createOverviewLoader(dataPath, { now, ...persistence });
  t.after(async () => {
    await loader.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('focusdesk-ai-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, dataPath, loader };
}

test('legacy AI omission preserves the original content hash and does not rewrite data', async t => {
  const { loader, dataPath } = await setup(t);
  const raw = await readFile(dataPath);
  const before = await loader.load();
  assert.equal(before.revision, createHash('sha256').update(JSON.stringify(seed)).digest('hex'));
  assert.equal(before.ai_suggestion, undefined);
  assert.deepEqual(await loader.updateAISuggestion({ revision: before.revision, ai_suggestion: '' }), before);
  assert.deepEqual(await readFile(dataPath), raw);
});

test('AI persists through restart and ordinary task, focus and work-state writes, and can be cleared', async t => {
  const { loader, dataPath } = await setup(t, { ...seed, work_state: work, signals: [signal] });
  const before = await loader.load();
  const suggestion = '先写提纲。\nFocus for 25 minutes.';
  let saved = await loader.updateAISuggestion({ revision: before.revision, ai_suggestion: suggestion });
  assert.notEqual(saved.revision, before.revision);
  assert.deepEqual(saved.tasks, before.tasks);
  assert.deepEqual(saved.work_state, work);
  assert.deepEqual(saved.signals, [signal]);
  const restarted = createOverviewLoader(dataPath, { now });
  assert.deepEqual(await restarted.load(), saved);
  await restarted.close();
  saved = await loader.update({ revision: saved.revision, tasks: [{ ...seed.tasks[0], title: 'Refine outline' }] });
  saved = await loader.updateFocus({ revision: saved.revision, action: 'start', task_id: 'draft' });
  saved = await loader.updateWorkState({ revision: saved.revision, work_state: { ...work, goal: 'Ship draft' }, signals: [signal] });
  assert.equal(saved.ai_suggestion, suggestion);
  const focused = saved.focus;
  saved = await loader.updateAISuggestion({ revision: saved.revision, ai_suggestion: 'Review the outline.' });
  assert.deepEqual(saved.focus, focused);
  const raw = await readFile(dataPath);
  assert.deepEqual(await loader.updateAISuggestion({ revision: saved.revision, ai_suggestion: saved.ai_suggestion }), saved);
  assert.deepEqual(await readFile(dataPath), raw);
  saved = await loader.updateAISuggestion({ revision: saved.revision, ai_suggestion: '' });
  assert.equal(saved.ai_suggestion, '');
  assert.equal(JSON.parse(await readFile(dataPath, 'utf8')).ai_suggestion, '');
});

test('AI writes share revision conflicts with task edits and reject invalid text before saving', async t => {
  const { loader, dataPath } = await setup(t);
  const before = await loader.load();
  const results = await Promise.allSettled([
    loader.updateAISuggestion({ revision: before.revision, ai_suggestion: 'Start small.' }),
    loader.update({ revision: before.revision, tasks: [] }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.ok(results[1].reason instanceof RevisionConflictError);
  const raw = await readFile(dataPath);
  await assert.rejects(loader.updateAISuggestion({ revision: before.revision, ai_suggestion: 'Stale edit' }), RevisionConflictError);
  assert.throws(() => loader.updateAISuggestion({ revision: results[0].value.revision, ai_suggestion: 'x'.repeat(121) }));
  assert.deepEqual(await readFile(dataPath), raw);
});

test('failed AI persistence retains original data and cleans its temporary file', async t => {
  const { loader, dataPath, directory } = await setup(t, seed, { replace: async () => { throw new Error('Injected rename failure'); } });
  const before = await loader.load();
  const raw = await readFile(dataPath);
  await assert.rejects(loader.updateAISuggestion({ revision: before.revision, ai_suggestion: 'Start small.' }), { code: 'TASK_SOURCE_WRITE_FAILED' });
  assert.deepEqual(await readFile(dataPath), raw);
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
});

test('desktop import preserves source suggestions and exact previous backup bytes', async t => {
  const { loader, dataPath, directory } = await setup(t, { ...seed, ai_suggestion: 'Original advice' });
  const before = await loader.load();
  const raw = await readFile(dataPath);
  const candidate = { ...seed, ai_suggestion: '导入的建议。' };
  assert.deepEqual(validateDesktopSource(candidate), candidate);
  const backupsPath = path.join(directory, 'backups');
  const imported = await loader.importSource(candidate, { revision: before.revision, confirmed: true, backupsPath });
  assert.equal(imported.ai_suggestion, candidate.ai_suggestion);
  const backups = await readdir(backupsPath);
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(backupsPath, backups[0])), raw);
  const legacy = await loader.importSource(seed, { revision: imported.revision, confirmed: true, backupsPath });
  assert.equal(legacy.ai_suggestion, undefined);
});

test('AI HTTP updates enforce origin, validation, method and version rules and return saved state', async t => {
  const { loader, dataPath, directory } = await setup(t);
  const server = createDemoServer({ dataPath, distPath: directory, loader });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/api/v1/daily-overview/ai-suggestion`;
  const before = await loader.load();
  const input = { revision: before.revision, ai_suggestion: '先完成最重要的一项。' };
  const put = (value, headers = {}) => fetch(endpoint, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value) });
  for (const Origin of ['', 'http://other.example']) assert.equal((await put(input, { Origin })).status, 403);
  assert.equal((await put(input, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await put(' '.repeat(4097))).status, 413);
  const invalid = await put({ ...input, ai_suggestion: 'x'.repeat(121) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_AI_SUGGESTION');
  const method = await fetch(endpoint);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'PUT');
  const response = await put(input);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.ai_suggestion, input.ai_suggestion);
  assert.deepEqual(await (await fetch(`${origin}/api/v1/daily-overview`)).json(), saved);
  assert.equal((await put(input)).status, 409);
  const cleared = await put({ revision: saved.revision, ai_suggestion: '' });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).ai_suggestion, '');
});
