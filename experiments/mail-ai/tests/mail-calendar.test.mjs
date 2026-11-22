import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDemoServer } from '../../../backend/src/service.ts';
import { planRevision, readCalendar, saveMailPlan } from '../mail-calendar.mjs';
import { sourceTaskId } from '../task-import.mjs';

const draft = { sourceKey: 'mail:synthetic:one', title: '核对课程材料', deviceTitle: 'Review course notes', sourceTitle: '   ',
  dueAt: '2026-11-26T18:00:00.000Z', dueDate: '2026-11-27', plannedDate: '2026-11-27' };

async function start(t, tasks = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-mail-plan-'));
  const dataPath = path.join(dir, 'tasks.json');
  await writeFile(dataPath, JSON.stringify({ timezone: 'UTC', date: '2026-11-16', tasks }));
  const server = createDemoServer({ dataPath, distPath: dir, now: () => Date.parse('2026-11-16T12:00:00Z') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dir, { recursive: true, force: true }); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('precise deadlines use the Hub day, a chosen plan stays separate, and date-only deadlines keep their date', async t => {
  const hub = await start(t);
  const automatic = await saveMailPlan({ hub, ...draft, automatic: true });
  assert.equal(automatic.entry.plannedDate, '2026-11-26');
  assert.equal(automatic.entry.dueDate, '2026-11-26');
  assert.equal(automatic.entry.dueAt, draft.dueAt);
  assert.equal(automatic.entry.sourceTitle, undefined);
  const change = await saveMailPlan({ hub, ...draft, plannedDate: '2026-11-17' });
  assert.equal(change.entry.plannedDate, '2026-11-17');
  assert.equal(change.entry.dueDate, '2026-11-26');
  assert.equal((await saveMailPlan({ hub, ...draft, automatic: true })).entry.plannedDate, '2026-11-17');
  const dayOnly = await saveMailPlan({ hub, ...draft, sourceKey: 'mail:synthetic:two', dueAt: null, automatic: true });
  assert.equal(dayOnly.entry.plannedDate, '2026-11-27');
  assert.equal(dayOnly.entry.dueDate, '2026-11-27'); assert.equal(dayOnly.entry.dueAt, null);
});

test('moving an old same-source daily task out of today and explicitly restoring a deleted mail plan keep one source', async t => {
  const id = sourceTaskId(draft.sourceKey);
  const hub = await start(t, [{ id, title: draft.deviceTitle, status: 'todo', due_at: draft.dueAt }]);
  const { entry } = await saveMailPlan({ hub, ...draft, plannedDate: '2026-11-17' });
  assert.equal(entry.id, id);
  assert.deepEqual((await (await fetch(hub + '/api/v1/daily-overview')).json()).tasks, []);
  const beforeDelete = await readCalendar(hub);
  const removed = await fetch(hub + '/api/v1/calendar', { method: 'DELETE', headers: { Origin: hub, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: beforeDelete.revision, id }) });
  assert.equal(removed.status, 200);
  assert.equal((await saveMailPlan({ hub, ...draft, automatic: true })).entry.status, 'removed');
  await assert.rejects(saveMailPlan({ hub, ...draft }), /移除/);
  const restored = await saveMailPlan({ hub, ...draft, plannedDate: '2026-11-18', restore: true });
  assert.equal(restored.entry.status, 'scheduled');
  assert.equal(restored.entry.plannedDate, '2026-11-18');
  assert.equal((await readCalendar(hub)).entries.length, 1);
});

test('a change to the same entry between reading and writing returns a conflict with the new plan', async t => {
  const hub = await start(t);
  const initial = await saveMailPlan({ hub, ...draft });
  let injected = false;
  async function concurrent(url, opts) {
    if (!injected && opts.method === 'PUT') {
      injected = true;
      await saveMailPlan({ hub, ...draft, plannedDate: '2026-11-20' });
    }
    return fetch(url, opts);
  }
  await assert.rejects(saveMailPlan({ hub, ...draft, plannedDate: '2026-11-17', expectedRevision: initial.planRevision,
    fetcher: concurrent }), error => error.status === 409 && error.current.plannedDate === '2026-11-20' &&
    error.planRevision === planRevision(error.current));
  assert.equal((await readCalendar(hub)).entries[0].plannedDate, '2026-11-20');
});
