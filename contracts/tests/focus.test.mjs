import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDailyOverview } from '../daily-overview.ts';
import { parseFocusUpdateRequest, parseFocusUpdateText } from '../focus-update.ts';

const seed = JSON.parse(await readFile(new URL('../fixtures/focus.json', import.meta.url), 'utf8'));
test('focus contract accepts legacy, explicit idle and active snapshots without aliasing', () => {
  const copy = parseDailyOverview(seed);
  assert.deepEqual(copy, seed); assert.notEqual(copy.focus, seed.focus);
  const { focus, ...legacy } = seed;
  assert.deepEqual(parseDailyOverview(legacy), legacy);
  assert.equal(parseDailyOverview({ ...legacy, focus: null }).focus, null);
});
test('focus contract rejects mismatched task/status, invalid times, wrong precision and duration', () => {
  for (const focus of [false, {}, { ...seed.focus, task_id: 'missing' },
    { ...seed.focus, ends_at: '2026-11-03T16:14:00.000Z' },
    { ...seed.focus, started_at: '2026-02-30T15:50:00.000Z' },
    { ...seed.focus, ends_at: '2026-11-03T16:15:00Z' },
    { ...seed.focus, started_at: seed.focus.ends_at, ends_at: seed.focus.started_at },
  ]) assert.throws(() => parseDailyOverview({ ...seed, focus }));
  assert.throws(() => parseDailyOverview({ ...seed, tasks: [{ ...seed.tasks[0], status: 'done' }] }));
});
test('focus writes allow only start/stop with revision and server-owned times', () => {
  for (const valid of [{ revision: 'base', action: 'start', task_id: 'task' }, { revision: 'base', action: 'stop' }]) {
    assert.deepEqual(parseFocusUpdateText(JSON.stringify(valid)), valid);
  }
  for (const invalid of [null, {}, { revision: 'base', action: 'pause' },
    { revision: 'base', action: 'start' }, { revision: 'base', action: 'stop', task_id: 'task' },
    { revision: 'base', action: 'start', task_id: 'task', duration: 1 },
    { revision: 'base', action: 'start', task_id: 'task', ends_at: seed.focus.ends_at },
  ]) assert.throws(() => parseFocusUpdateRequest(invalid));
  assert.throws(() => parseFocusUpdateText('{'));
  assert.throws(() => parseFocusUpdateText(' '.repeat(4097)));
});
