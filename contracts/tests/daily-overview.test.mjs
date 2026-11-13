import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_OVERVIEW_BYTES,
  MAX_TASKS,
  OverviewValidationError,
  parseDailyOverview,
  parseDailyOverviewText,
} from '../daily-overview.ts';

const fixtures = {};
for (const name of ['today', 'empty', 'completed', 'next-day', 'device-demo']) {
  fixtures[name] = JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

for (const [name, input] of Object.entries(fixtures)) {
  test(`accepts shared ${name} fixture and preserves order`, () => {
    const output = parseDailyOverviewText(JSON.stringify(input));
    assert.deepEqual(output, input);
    assert.notEqual(output.tasks, input.tasks);
  });
}

test('represents empty, completed, and date rollover distinctly', () => {
  assert.equal(parseDailyOverview(fixtures.empty).tasks.length, 0);
  assert.ok(parseDailyOverview(fixtures.completed).tasks.every(t => t.status === 'done'));
  assert.notEqual(fixtures.today.date, fixtures['next-day'].date);
  assert.notEqual(fixtures.today.revision, fixtures['next-day'].revision);
});

const invalidCases = [
  ['unknown version', d => { d.schema_version = '2.0'; }],
  ['missing revision', d => { delete d.revision; }],
  ['blank revision', d => { d.revision = ' '; }],
  ['non-ASCII revision', d => { d.revision = '版本'; }],
  ['overlong revision', d => { d.revision = 'x'.repeat(65); }],
  ['invalid calendar day', d => { d.date = '2026-02-30'; }],
  ['non-leap February', d => { d.date = '2100-02-29'; }],
  ['invalid month', d => { d.date = '2026-13-01'; }],
  ['invalid year', d => { d.date = '0000-01-01'; }],
  ['unrecognized timezone', d => { d.timezone = 'Mars/Olympus'; }],
  ['numeric timezone offset', d => { d.timezone = '+08:00'; }],
  ['invalid timestamp date', d => { d.updated_at = '2026-02-30T01:00:00Z'; }],
  ['invalid timestamp hour', d => { d.updated_at = '2026-11-02T24:00:00Z'; }],
  ['non-UTC timestamp', d => { d.updated_at = '2026-11-02T08:00:00+08:00'; }],
  ['timestamp leap second outside Demo subset', d => { d.updated_at = '2026-11-02T01:00:60Z'; }],
  ['missing tasks', d => { delete d.tasks; }],
  ['non-array tasks', d => { d.tasks = {}; }],
  ['too many tasks', d => { d.tasks = Array.from({ length: MAX_TASKS + 1 }, (_, index) => ({ ...d.tasks[0], id: `task-${index}` })); }],
  ['null task', d => { d.tasks[0] = null; }],
  ['duplicate task IDs', d => { d.tasks[1].id = d.tasks[0].id; }],
  ['invalid task ID', d => { d.tasks[0].id = 'with space'; }],
  ['unknown task state', d => { d.tasks[0].status = 'pending'; }],
  ['missing due_at', d => { delete d.tasks[0].due_at; }],
  ['invalid due date', d => { d.tasks[0].due_at = '2026-04-31T03:00:00Z'; }],
  ['empty title', d => { d.tasks[0].title = ''; }],
  ['whitespace title', d => { d.tasks[0].title = '   '; }],
  ['overlong Unicode title', d => { d.tasks[0].title = '中'.repeat(41); }],
  ['title newline', d => { d.tasks[0].title = 'a\nb'; }],
  ['title control character', d => { d.tasks[0].title = 'a\u0000b'; }],
  ['Unicode line separator', d => { d.tasks[0].title = 'a\u2028b'; }],
  ['invalid Unicode high surrogate', d => { d.tasks[0].title = '\ud800'; }],
  ['invalid Unicode low surrogate', d => { d.tasks[0].title = '\udfff'; }],
  ['oversized object with unknown fields', d => { d.padding = 'x'.repeat(MAX_OVERVIEW_BYTES); }],
];

for (const [label, mutate] of invalidCases) {
  test(`rejects ${label}`, () => {
    const data = structuredClone(fixtures.today);
    mutate(data);
    assert.throws(() => parseDailyOverview(data), OverviewValidationError);
  });
}

test('accepts leap dates and maximum code point/UTF-8 title boundary', () => {
  const input = structuredClone(fixtures.today);
  input.date = '2000-02-29';
  input.tasks[0].title = '😀'.repeat(40);
  input.updated_at = '2000-02-29T23:59:59.123456Z';
  assert.equal(parseDailyOverview(input).tasks[0].title, input.tasks[0].title);
});

test('ignores extra fields without leaking them to consumers', () => {
  const input = structuredClone(fixtures.today);
  input.internal_note = 'not a display field';
  input.tasks[0].internal_note = 'also not a display field';
  assert.deepEqual(parseDailyOverview(input), fixtures.today);
});

test('rejects invalid JSON, a non-object root, and oversized raw bodies', () => {
  assert.throws(() => parseDailyOverviewText('{'), OverviewValidationError);
  for (const value of [null, [], true, 1, 'text']) {
    assert.throws(() => parseDailyOverview(value), OverviewValidationError);
  }
  assert.throws(() => parseDailyOverviewText(' '.repeat(MAX_OVERVIEW_BYTES) + '{}'), OverviewValidationError);
});

test('keeps fixtures isolated from consumer mutation', () => {
  const parsed = parseDailyOverview(fixtures.today);
  parsed.tasks[0].title = 'Changed locally';
  assert.notEqual(parsed.tasks[0].title, fixtures.today.tasks[0].title);
});

test('rejects non-serializable input', () => {
  const input = structuredClone(fixtures.today);
  input.cycle = input;
  assert.throws(() => parseDailyOverview(input), OverviewValidationError);
});

test('enforces the exact raw UTF-8 body boundary before JSON parsing', () => {
  const body = JSON.stringify(fixtures.today);
  const padding = MAX_OVERVIEW_BYTES - Buffer.byteLength(body, 'utf8');
  const exactLimit = body + ' '.repeat(padding);
  assert.equal(Buffer.byteLength(exactLimit, 'utf8'), MAX_OVERVIEW_BYTES);
  assert.deepEqual(parseDailyOverviewText(exactLimit), fixtures.today);
  assert.throws(() => parseDailyOverviewText(exactLimit + ' '), OverviewValidationError);
});

test('accepts a 64-byte task ID without normalization', () => {
  const input = structuredClone(fixtures.today);
  input.tasks[0].id = 'A'.repeat(64);
  assert.equal(parseDailyOverview(input).tasks[0].id, input.tasks[0].id);
});

test('accepts a literal replacement character and a valid joined emoji', () => {
  const input = structuredClone(fixtures.today);
  input.tasks[0].title = '\ufffd 👩‍💻';
  assert.equal(parseDailyOverview(input).tasks[0].title, input.tasks[0].title);
});

test('rejects sparse task arrays in the object entry point', () => {
  const input = structuredClone(fixtures.today);
  delete input.tasks[0];
  assert.throws(() => parseDailyOverview(input), OverviewValidationError);
});

test('cannot bypass the output size limit with a custom input toJSON', () => {
  const input = structuredClone(fixtures.today);
  input.updated_at = '2026-11-02T01:00:00.' + '1'.repeat(5000) + 'Z';
  input.toJSON = () => ({});
  assert.throws(() => parseDailyOverview(input), OverviewValidationError);
});
