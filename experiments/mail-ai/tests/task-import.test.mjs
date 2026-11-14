import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDemoServer } from '../../../backend/src/service.ts';
import { deriveDeadline, importTask } from '../task-import.mjs';

test('a date and a submission time are both required, and the Beijing day can differ from the UTC day', () => {
  const received = '2026-11-29T17:20:00Z'; // Nov 30 in Beijing.
  for (const [line, expected] of [
    ['Please submit Lab 3 by 2026-12-02 17:30.', '2026-12-02T09:30:00.000Z'],
    ['请在 2026年12月2日 17:30 前提交第三次实验。', '2026-12-02T09:30:00.000Z'],
    ['请于后天 09:15 前上传计划。', '2026-12-02T01:15:00.000Z'],
    ['Please upload the plan by tomorrow at 09:15.', '2026-12-01T01:15:00.000Z'],
    ['Submit the report by 2026-12-02 12:15 am.', '2026-12-01T16:15:00.000Z'],
    ['Submit by 2026-12-02 12:15 UTC.', '2026-12-02T12:15:00.000Z'],
    ['Submit by 2026-12-02T12:15Z.', '2026-12-02T12:15:00.000Z'],
    ['Submit by 2026-12-02 12:15 GMT+8.', '2026-12-02T04:15:00.000Z'],
    ['Upload the plan by 2026-12-02T12:15+05:30.', '2026-12-02T06:45:00.000Z'],
  ]) assert.equal(deriveDeadline(line, received), expected, line);
});

test('cancelled, ambiguous, invalid, event-only and imprecise dates stay out of the task list', () => {
  const received = '2026-11-13T14:00:00Z';
  for (const quote of [
    '请提交作业。截止为 2026-11-16 17:00。',
    '请在 2026-11-16 17:00 前提交报告，提交要求已取消。',
    'The original deadline to submit was 2026-11-16 17:00.',
    'Please meet by 2026-11-16 17:00.',
    'Team meeting at 2026-11-16 17:00 to discuss how to submit by Friday.',
    'Please submit the survey.', 'Please submit by 2026-11-16.',
    'Please upload on 2026-11-16 17:00.',
    'Submit by 2026-11-16 17:00 or 2026-11-17 12:00.',
    'Submit by 2026-11-16 17:00 or 18:00.',
    'Submit by 2026-11-16 17:00 or 6 pm.',
    'Submit by 2026-11-16 08:00 p.m.',
    'Submit by 2026-11-16 14:30 CST.',
    'Submit by 2026-11-16 12:00 Los Angeles time.',
    'Submit by 2026-02-30 14:30.', 'Submit by 2026-11-16 24:31.',
    'Submit by 2026-11-12 14:30.',
  ]) assert.equal(deriveDeadline(quote, received), null, quote);
  assert.equal(deriveDeadline('Please submit by tomorrow 19:30.', null), null);
  assert.equal(deriveDeadline('Please submit by tomorrow 19:30.', '2026-01-01'), null);
  assert.equal(deriveDeadline('请在大后天 08:30 前提交报告。', received), null);
});

const due = '2026-11-16T09:00:00.000Z';
const now = Date.parse('2026-11-14T08:00:00.000Z');
const prior = { id: 'manual', title: 'My existing task', status: 'todo', due_at: null };
const focus = { task_id: 'manual', started_at: new Date(now - 60_000).toISOString(), ends_at: new Date(now + 24 * 60_000).toISOString() };

async function isolatedHub(t, tasks = [prior]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'FocusDesk 邮件导入 '));
  const dataPath = path.join(dir, 'tasks.json');
  await writeFile(dataPath, JSON.stringify({ date: '2026-11-14', timezone: 'Asia/Shanghai', tasks, focus }), 'utf8');
  let server, clock = now;
  async function start() {
    server = createDemoServer({ distPath: dir, dataPath, now: () => clock });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  async function close() {
    if (!server?.listening) return;
    await new Promise(resolve => server.close(resolve));
  }
  await start();
  t.after(async () => { await close(); await rm(dir, { force: true, recursive: true }); });
  return { dataPath,
    get origin() { return `http://127.0.0.1:${server.address().port}`; },
    async restartLater() { await close(); clock += 2 * 24 * 60 * 60_000; await start(); },
  };
}

async function updateTasks(hub, edit) {
  const url = hub + '/api/v1/daily-overview';
  const { tasks, revision } = await (await fetch(url)).json();
  const response = await fetch(url + '/tasks', { method: 'PUT', headers: { Origin: hub, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks: edit(tasks), revision }) });
  assert.equal(response.status, 200);
  return response.json();
}

test('the real Hub keeps a future task and user changes across retries, completion and a later restart', async t => {
  const server = await isolatedHub(t);
  const input = { sourceKey: 'example-mailbox:message-77:plan', title: 'Upload the plan', dueAt: due };
  const add = changes => importTask({ ...input, hub: server.origin, ...changes });
  const first = await add();
  assert.equal(first.status, 'added');
  const source = JSON.parse(await readFile(server.dataPath, 'utf8'));
  assert.deepEqual(source.tasks, [prior, { id: first.id, title: input.title, status: 'todo', due_at: due }]);
  assert.deepEqual(source.focus, focus);
  await updateTasks(server.origin, tasks => tasks.map(task => task.id === first.id ? { ...task, title: 'Edited by me', status: 'done' } : task));
  await server.restartLater();
  const original = await readFile(server.dataPath, 'utf8');
  assert.equal((await add()).status, 'existing');
  assert.equal((await add({ dueAt: '2026-11-18T09:00:00Z' })).status, 'review');
  assert.equal(await readFile(server.dataPath, 'utf8'), original);
  const overview = await (await fetch(server.origin + '/api/v1/daily-overview')).json();
  assert.deepEqual(overview.tasks[1], { id: first.id, title: 'Edited by me', status: 'done', due_at: due });
});

test('a concurrent Dashboard write wins its revision and is preserved by the import retry', async t => {
  const server = await isolatedHub(t), statuses = [];
  let injected = false;
  async function racingFetch(url, options) {
    if (options.method === 'PUT' && !injected) {
      injected = true;
      await updateTasks(server.origin, tasks => [...tasks, { id: 'another', title: 'Concurrent addition', status: 'todo', due_at: null }]);
    }
    const result = await fetch(url, options);
    if (options.method === 'PUT') statuses.push(result.status);
    return result;
  }
  const result = await importTask({ hub: server.origin, sourceKey: 'course/report', title: 'Submit report', dueAt: due, fetcher: racingFetch });
  assert.equal(result.status, 'added');
  assert.deepEqual(statuses, [409, 200]);
  const source = JSON.parse(await readFile(server.dataPath, 'utf8'));
  assert.deepEqual(source.tasks.map(task => task.id), ['manual', 'another', result.id]);
  assert.deepEqual(source.focus, focus);
});

test('a full list or an invalid candidate cannot replace tasks', async t => {
  const tasks = [prior, ...Array.from({ length: 9 }, (_, i) => ({ ...prior, id: `local-${i}` }))];
  const server = await isolatedHub(t, tasks), original = await readFile(server.dataPath, 'utf8');
  const input = { hub: server.origin, sourceKey: 'source', title: 'Valid task', dueAt: due };
  assert.equal((await importTask(input)).status, 'full');
  assert.equal((await importTask({ ...input, title: '中文' })).status, 'review');
  assert.equal((await importTask({ ...input, dueAt: null })).status, 'review');
  assert.equal(await readFile(server.dataPath, 'utf8'), original);
});

test('refuses remote Hub addresses and disables redirects on requests', async () => {
  const input = { sourceKey: 'source', title: 'Valid task', dueAt: due };
  for (const hub of ['https://example.test', 'http://127.0.0.1@example.test', 'http://127.0.0.1:8787/other', 'http://localhost.test']) {
    await assert.rejects(importTask({ ...input, hub, fetcher: () => assert.fail('invalid Hub should not receive a request') }), /本机/);
  }
  await assert.rejects(importTask({ ...input, hub: 'http://127.0.0.1:8787', fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 503 });
  } }), /503/);
});
