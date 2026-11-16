import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskUpdateRequest, parseTaskUpdateText } from '../task-update.ts';
import { MAX_TASKS } from '../daily-overview.ts';

const source = {
  revision: 'demo-current',
  tasks: [{ id: 'task-001', title: 'Review work', status: 'todo', due_at: null }],
};

test('accepts task edits as fresh data and supports an explicit empty task list', () => {
  const parsed = parseTaskUpdateRequest(source);
  assert.deepEqual(parsed, source);
  parsed.tasks[0].title = 'Consumer change';
  assert.equal(source.tasks[0].title, 'Review work');
  assert.deepEqual(parseTaskUpdateText('{"revision":"current","tasks":[]}').tasks, []);
  const maximum = { ...source, tasks: Array.from({ length: MAX_TASKS }, (_, index) => ({ ...source.tasks[0], id: `task-${index}` })) };
  assert.deepEqual(parseTaskUpdateText(JSON.stringify(maximum)), maximum);
});

test('accepts Chinese and mixed-language titles and preserves optional device labels', () => {
  const rows = [
    { ...source.tasks[0], title: '看论文', device_title: 'Read paper' },
    { ...source.tasks[0], id: 'second', title: '重读 Chapter 3 📖' },
  ];
  const request = { ...source, tasks: rows };
  assert.deepEqual(parseTaskUpdateText(JSON.stringify(request)), request);
});

for (const [name, edit] of [
  ['date write', x => { x.date = '2026-11-03'; }],
  ['missing revision', x => { delete x.revision; }],
  ['missing tasks', x => { delete x.tasks; }],
  ['invalid device title', x => { x.tasks[0].device_title = '中文'; }],
  ['blank title', x => { x.tasks[0].title = ' '; }],
  ['too many tasks', x => { x.tasks = Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ ...x.tasks[0], id: `task-${i}` })); }],
  ['duplicate IDs', x => { x.tasks.push({...x.tasks[0]}); }],
  ['missing due_at', x => { delete x.tasks[0].due_at; }],
  ['invalid state', x => { x.tasks[0].status = 'pending'; }],
]) {
  test(`rejects ${name}`, () => {
    const input = structuredClone(source);
    edit(input);
    assert.throws(() => parseTaskUpdateRequest(input));
  });
}

test('rejects invalid JSON and bounds the original request body including whitespace', () => {
  assert.throws(() => parseTaskUpdateText('{'));
  assert.throws(() => parseTaskUpdateText(' '.repeat(4096) + '{}'));
});
