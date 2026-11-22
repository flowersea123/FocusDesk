import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TASKS, parseDailyOverview } from '../daily-overview.ts';
import { parseWorkStateUpdateRequest } from '../work-state.ts';
import { buildDisplaySnapshot, rasterizeDisplaySnapshot } from '../display-snapshot.ts';
import { DISPLAY_FONTS } from '../display-fonts.ts';

const base = {
  schema_version: '1.0', revision: 'synthetic-v02', date: '2026-11-11', timezone: 'UTC', updated_at: '2026-11-11T10:00:00.000Z',
  tasks: [{ id: 'one', title: 'Write release notes', status: 'todo', due_at: null }, { id: 'two', title: 'Review the prototype', status: 'todo', due_at: null }],
};
const state = { goal: 'Make room for deep work', current_action: 'Write the first draft', next_action: 'Review with the team' };
const event = { id: 'manual-1', content: 'Review the prototype at 14:00', source: 'Manual', created_at: base.updated_at, priority: 'normal', status: 'active' };
const texts = snapshot => snapshot.commands.filter(op => op[0] === 1).map(op => op[5]);

test('old overview stays valid and renders the minimal task layout and recommendation placeholder', () => {
  const parsed = parseDailyOverview(base);
  assert.equal(parsed.work_state, undefined);
  const snapshot = buildDisplaySnapshot(parsed);
  assert.equal(snapshot.width, 400); assert.equal(snapshot.height, 300);
  assert.ok(texts(snapshot).includes('FOCUSDESK'));
  assert.ok(texts(snapshot).includes('Tasks'));
  assert.ok(texts(snapshot).includes(base.tasks[0].title));
  assert.ok(texts(snapshot).includes(base.tasks[1].title));
  assert.ok(texts(snapshot).includes('AI RECOMMENDATION'));
  assert.ok(texts(snapshot).includes('No suggestion yet.'));
  assert.ok(texts(snapshot).includes('0 / 2 DONE'));
  assert.ok(!texts(snapshot).some(text => /Wi-?Fi|offline|online/i.test(text)));
});
test('optional work state and signals validate and copy all fields', () => {
  const input = { ...base, work_state: state, signals: [event] };
  const parsed = parseDailyOverview(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.work_state, state); assert.notEqual(parsed.signals[0], event);
  assert.deepEqual(parseWorkStateUpdateRequest({ revision: base.revision, work_state: state, signals: [event] }).signals, [event]);
});
test('manual events remain intact and do not acquire fabricated AI suggestion provenance', () => {
  const normal = { ...event, id: 'normal' };
  const urgent = { ...event, id: 'urgent', priority: 'urgent', content: 'Check the release blocker' };
  const input = { ...base, work_state: state, signals: [normal, urgent] };
  const previous = structuredClone(input);
  const snapshot = buildDisplaySnapshot(input);
  assert.deepEqual(input, previous);
  assert.ok(texts(snapshot).includes('No suggestion yet.'));
  assert.ok(!texts(snapshot).includes(urgent.content));
  assert.ok(!texts(snapshot).includes(normal.content));
  assert.ok(texts(snapshot).includes('AI RECOMMENDATION'));
  for (const status of ['active', 'acknowledged', 'ignored', 'closed']) {
    assert.deepEqual(buildDisplaySnapshot({ ...base, signals: [{ ...urgent, status }] }).commands, buildDisplaySnapshot(base).commands);
  }
});
test('Focus Mode moves the selected task first and retains the next unfinished task and saved work fields', () => {
  const overview = { ...base, work_state: state, focus: { task_id: 'two', started_at: base.updated_at, ends_at: '2026-11-11T10:25:00.000Z' } };
  const snapshot = buildDisplaySnapshot(overview);
  const priorityLines = snapshot.commands.filter(op => op[0] === 1 && op[3] === 1);
  assert.equal(priorityLines.map(op => op[5]).join(' '), base.tasks[1].title);
  assert.ok(texts(snapshot).includes('FOCUS - UNTIL 10:25'));
  assert.ok(texts(snapshot).includes(base.tasks[0].title));
  assert.deepEqual(overview.work_state, state);
  assert.equal(texts(buildDisplaySnapshot({ ...overview, focus: null })).filter(text => text === base.tasks[0].title).length, 1);
  const shanghai = buildDisplaySnapshot({ ...overview, timezone: 'Asia/Shanghai' });
  assert.ok(texts(shanghai).includes('FOCUS - UNTIL 18:25'));
});
test('invalid extensions, unsupported fields and invalid signal times are rejected', () => {
  for (const changes of [
    { work_state: { ...state, goal: 'x'.repeat(65) } },
    { work_state: { ...state, goal: '中文' } },
    { work_state: { ...state, hidden: true } },
    { signals: Array(5).fill(event) },
    { signals: [event, event] },
    { signals: [{ ...event, created_at: '2026-02-30T10:00:00.000Z' }] },
    { signals: [{ ...event, priority: 'critical' }] },
    { signals: [{ ...event, status: 'unknown' }] },
  ]) assert.throws(() => parseDailyOverview({ ...base, ...changes }));
});
test('all generated glyph ink and shapes stay inside 400x300 for long text and drafts', () => {
  for (const value of ['W'.repeat(64), 'j'.repeat(64), 'Goal: (keep it simple!)', '中文 Goal', '   ', 'Long words with breaks '.repeat(3),
    ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index).repeat(120))]) {
    const snapshot = buildDisplaySnapshot({ ...base,
      tasks: base.tasks.map(task => ({ ...task, title: value.slice(0, 40) })),
      ai_suggestion: value, work_state: { goal: value, current_action: value, next_action: value }, signals: [{ ...event, priority: 'action_needed' }] });
    assert.ok(snapshot.commands.length <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 4096);
    for (const op of snapshot.commands) {
      if (op[0] === 0) {
        assert.ok(op[1] >= 0 && op[2] >= 0 && op[1] + op[3] <= 400 && op[2] + op[4] <= 300);
        continue;
      }
      if (op[0] !== 1) continue;
      assert.ok(op[5].length <= 96 && /^[\x20-\x7e]+$/.test(op[5]));
      let cursor = op[1];
      for (const char of op[5]) {
        const glyph = DISPLAY_FONTS[op[3]].glyphs[char.charCodeAt(0) - 32];
        const [, w, h, advance, x, y] = glyph;
        assert.ok(cursor + x >= 0 && cursor + x + w <= 400, `horizontal ${op[5]}`);
        assert.ok(op[2] + y >= 0 && op[2] + y + h <= 300, `vertical ${op[5]}`);
        cursor += advance;
        assert.ok(cursor <= 400, `cursor ${op[5]}`);
      }
    }
    const priorityLines = snapshot.commands.filter(op => op[0] === 1 && op[3] === 1);
    assert.ok(priorityLines.length <= 1);
    const pixels = rasterizeDisplaySnapshot(snapshot);
    assert.equal(pixels.length, 120000);
    assert.ok(pixels.every(color => color >= 0 && color <= 3));
  }
});
test('snapshot is deterministic and shares source revision with a layout discriminator', () => {
  assert.deepEqual(buildDisplaySnapshot(base), buildDisplaySnapshot(structuredClone(base)));
  assert.equal(buildDisplaySnapshot(base).revision, `goal-1:tasks4:${base.revision}`);
  assert.notEqual(buildDisplaySnapshot(base).revision, `goal-1:nun1:${base.revision}`);
  assert.notEqual(buildDisplaySnapshot(base).revision, `goal-1:ss:${base.revision}`);
  assert.equal(buildDisplaySnapshot(base).layout_version, 'goal-1');
  assert.notEqual(buildDisplaySnapshot({ ...base, revision: 'new' }).revision, buildDisplaySnapshot(base).revision);
});
test('task order and duplicate titles are preserved independently of additional Hub work fields', () => {
  const snapshot = buildDisplaySnapshot({ ...base, work_state: { goal: '   ', current_action: ' ', next_action: ' ' },
    tasks: base.tasks.map(task => ({ ...task, title: 'Review' })) });
  assert.equal(texts(snapshot).filter(text => text === 'Review').length, 2);
  assert.ok(!texts(snapshot).includes('YOUR GOAL'));
  assert.ok(!texts(snapshot).includes('CURRENT ACTION'));
  assert.ok(!texts(snapshot).includes('UP NEXT'));
  assert.ok(!texts(snapshot).includes('NEXT ACTION'));
});

test('device layout shows four larger task rows, hidden count and rounded recommendation area', () => {
  const overview = { ...base, date: '2026-11-12', tasks: [
    { id: 'proposal', title: 'Write proposal', status: 'todo', due_at: null },
    { id: 'slides', title: 'Review slides', status: 'todo', due_at: null },
    { id: 'reading', title: 'Read 10 pages', status: 'todo', due_at: null },
    { id: 'plan', title: 'Plan tomorrow', status: 'todo', due_at: null },
    { id: 'notes', title: 'Organize notes', status: 'todo', due_at: null },
    { id: 'feedback', title: 'Reply to feedback', status: 'todo', due_at: null },
  ] };
  const snapshot = buildDisplaySnapshot(overview);
  const content = texts(snapshot);
  const ordered = ['FOCUSDESK', 'THU, NOV 12', 'Tasks', '0 / 6 DONE', 'Write proposal', 'Review slides', 'Read 10 pages', 'Plan tomorrow', '+2 more', 'AI RECOMMENDATION', 'No suggestion yet.'];
  assert.deepEqual(content, ordered);
  const pixels = rasterizeDisplaySnapshot(snapshot);
  const at = (x, y) => pixels[y * 400 + x];
  assert.equal(at(16, 86), 3);
  assert.equal(at(34, 90), 0);
  assert.equal(at(35, 92), 1);
  assert.equal(at(34, 119), 0);
  assert.equal(at(35, 121), 1);
  assert.equal(at(34, 177), 0);
  assert.equal(at(34, 206), 1);
  assert.equal(at(16, 224), 1);
  assert.equal(at(20, 224), 2);
  assert.equal(at(380, 280), 2);
  assert.equal(at(16, 290), 1);
  const focused = buildDisplaySnapshot({ ...overview, focus: { task_id: 'feedback', started_at: base.updated_at, ends_at: '2026-11-11T10:25:00.000Z' } });
  assert.deepEqual(texts(focused).slice(4, 10), ['FOCUS - UNTIL 10:25', 'Reply to feedback',
    'Write proposal', 'Review slides', 'Read 10 pages', '+2 more']);
  assert.ok(!texts(focused).includes('Plan tomorrow'));
});

test('maximum completed list remains within existing transport and command budgets', () => {
  const snapshot = buildDisplaySnapshot({ ...base, revision: 'a'.repeat(64), tasks: Array.from({ length: MAX_TASKS }, (_, index) => ({ id: String(index), title: 'W'.repeat(40), status: 'done', due_at: null })) });
  assert.ok(snapshot.commands.length <= 64);
  assert.ok(snapshot.revision.length <= 80);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 4096);
  assert.ok(snapshot.commands.filter(op => op[0] === 1).reduce((size, op) => size + op[5].length, 0) <= 1024);
  assert.ok(texts(snapshot).includes(`${MAX_TASKS} / ${MAX_TASKS} DONE`));
  assert.ok(texts(snapshot).includes('All tasks done'));
  assert.ok(!texts(snapshot).some(text => text.includes('more')));
  const empty = texts(buildDisplaySnapshot({ ...base, tasks: [] }));
  assert.ok(empty.includes('No tasks for today'));
  assert.ok(empty.includes('0 / 0 DONE'));
});

test('larger task typography uses existing fonts and preserves glyph registrations', () => {
  assert.deepEqual(DISPLAY_FONTS.map(font => font.name), [
    'FreeSans9pt7b', 'FreeSansBold9pt7b', 'FreeSansBold18pt7b', 'FreeSans12pt7b', 'FreeSansBold12pt7b',
    'SourceSans3Regular9pt7b', 'SourceSans3Bold9pt7b', 'SourceSans3Bold18pt7b', 'SourceSans3Regular12pt7b', 'SourceSans3Bold12pt7b',
    'NunitoRegular10px', 'NunitoBold10px', 'NunitoRegular11px', 'NunitoBold11px', 'NunitoRegular13px', 'NunitoRegular16px', 'NunitoBold16px', 'NunitoBold17px',
  ]);
  const snapshot = buildDisplaySnapshot({ ...base, tasks: [{ ...base.tasks[0], title: 'lab report' }, base.tasks[1]] });
  const textCommands = snapshot.commands.filter(op => op[0] === 1);
  assert.equal(textCommands.find(op => op[5] === 'FOCUSDESK')[3], 13);
  assert.equal(textCommands.find(op => op[5] === 'Tasks')[3], 17);
  assert.equal(textCommands.find(op => op[5] === 'lab report')[3], 1);
  assert.equal(textCommands.find(op => op[5] === 'lab report')[2], 101);
  assert.equal(textCommands.find(op => op[5] === base.tasks[1].title)[3], 0);
  assert.equal(textCommands.find(op => op[5] === 'AI RECOMMENDATION')[3], 11);
  assert.equal(textCommands.find(op => op[5] === 'No suggestion yet.')[3], 14);
  assert.equal(buildDisplaySnapshot({ ...base, tasks: [] }).commands.find(op => op[0] === 1 && op[5] === 'No tasks for today')[3], 15);
  for (const overview of [base, { ...base, tasks: [] }, { ...base, tasks: base.tasks.map(task => ({ ...task, title: 'W'.repeat(40) })) },
    { ...base, focus: { task_id: 'one', started_at: base.updated_at, ends_at: '2026-11-11T10:25:00.000Z' } }]) {
    assert.ok(buildDisplaySnapshot(overview).commands.filter(op => op[0] === 1).every(op => [0, 1, 10, 11, 12, 13, 14, 15, 17].includes(op[3])));
  }
});

test('saved English suggestions wrap to two lines and preserve explicit line breaks', () => {
  const rows = suggestion => buildDisplaySnapshot({ ...base, ai_suggestion: suggestion }).commands
    .filter(op => op[0] === 1 && op[3] === 14).map(op => op[5]);
  assert.deepEqual(rows('Draft the outline.\nFocus for 25 minutes.'), ['Draft the outline.', 'Focus for 25 minutes.']);
  assert.deepEqual(rows('   '), ['No suggestion yet.']);
  assert.deepEqual(rows('先完成项目提纲'), ['Use English for device suggestions.']);
  assert.deepEqual(rows('Review tomorrow’s plan.'), ["Review tomorrow's plan."]);
  assert.equal(rows('First\nSecond\nThird')[1], 'Second...');
  const long = rows('W'.repeat(120));
  assert.equal(long.length, 2);
  assert.ok(long[1].endsWith('...'));
});

test('ten tasks with focus and a maximum-length suggestion fit firmware transport budgets', () => {
  const tasks = Array.from({ length: MAX_TASKS }, (_, index) => ({ id: `task-${index}`, title: 'W'.repeat(40), status: 'todo', due_at: null }));
  const snapshot = buildDisplaySnapshot({ ...base, tasks, revision: 'a'.repeat(64), ai_suggestion: 'W'.repeat(120),
    focus: { task_id: tasks.at(-1).id, started_at: base.updated_at, ends_at: '2026-11-11T10:25:00.000Z' } });
  assert.ok(snapshot.commands.length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 4096);
  assert.ok(snapshot.revision.length <= 80);
  assert.ok(texts(snapshot).includes('+6 more'));
  assert.equal(snapshot.commands.filter(op => op[0] === 1 && [0, 1].includes(op[3])).length, 4);
  for (const op of snapshot.commands.filter(op => op[0] === 1)) {
    let cursor = op[1];
    for (const char of op[5]) {
      const [, width, height, advance, left, top] = DISPLAY_FONTS[op[3]].glyphs[char.charCodeAt(0) - 32];
      assert.ok(cursor + left >= 0 && cursor + left + width <= 400);
      assert.ok(op[2] + top >= 0 && op[2] + top + height <= 300);
      cursor += advance;
      assert.ok(cursor <= 400);
    }
  }
});
