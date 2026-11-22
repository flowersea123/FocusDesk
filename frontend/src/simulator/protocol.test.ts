import { describe, expect, it } from 'vitest';
import { buildDisplaySnapshot, type DisplaySnapshot } from '../../../contracts/display-snapshot';
import { parseDailyOverview } from '../../../contracts/daily-overview';
import fixture from '../../../contracts/fixtures/device-demo.json';
import { parseDisplaySnapshotText } from './protocol';

const snapshot = (): DisplaySnapshot => buildDisplaySnapshot(parseDailyOverview(fixture));
const parse = (value: unknown) => parseDisplaySnapshotText(JSON.stringify(value));

describe('device snapshot protocol', () => {
  it('accepts real Hub output, including ten tasks and all existing font families', () => {
    const overview = parseDailyOverview(fixture);
    const scene = buildDisplaySnapshot({ ...overview, tasks: Array.from({ length: 10 }, (_, index) => ({
      id: `task-${index}`, title: 'A long but supported English task title', status: 'todo', due_at: null,
    })), ai_suggestion: 'Start with the outline. Then review.' });
    expect(parse(scene)).toEqual(scene);
    for (let font = 0; font <= 17; font++) {
      expect(parse({ ...snapshot(), commands: [[1, 20, 80, font, 0, 'Hello!']] }).commands).toHaveLength(1);
    }
  });

  it.each([
    ['protocol version', { schema_version: 'display-2' }],
    ['layout version', { layout_version: 'goal-2' }],
    ['screen size', { width: 800 }],
    ['extra fields', { another: true }],
    ['revision whitespace', { revision: 'not valid' }],
    ['long revision', { revision: 'x'.repeat(81) }],
    ['too many instructions', { commands: Array.from({ length: 65 }, () => [0, 0, 0, 1, 1, 0]) }],
    ['unknown instruction', { commands: [[3, 0, 0, 1, 1, 0]] }],
    ['rectangle overflow', { commands: [[0, 399, 299, 2, 1, 0]] }],
    ['negative coordinate', { commands: [[0, -1, 0, 1, 1, 0]] }],
    ['unknown font', { commands: [[1, 20, 80, 18, 0, 'Hello']] }],
    ['non-ASCII text', { commands: [[1, 20, 80, 10, 0, '中文']] }],
    ['unpaired surrogate', { commands: [[1, 20, 80, 10, 0, '\ud800']] }],
    ['line break', { commands: [[1, 20, 80, 10, 0, 'a\nb']] }],
    ['unknown color', { commands: [[1, 20, 80, 10, 4, 'Hello']] }],
    ['glyph above panel', { commands: [[1, 20, 0, 17, 0, 'Hello']] }],
    ['glyph left overhang', { commands: [[1, 0, 80, 10, 0, 'j']] }],
    ['advance beyond panel', { commands: [[1, 399, 80, 17, 0, '  ']] }],
    ['too much text in one instruction', { commands: [[1, 0, 80, 10, 0, ' '.repeat(97)]] }],
    ['too much total text', { commands: Array.from({ length: 11 }, () => [1, 0, 80, 10, 0, ' '.repeat(96)]) }],
    ['diamond overflow', { commands: [[2, 399, 100, 2, 0, 1]] }],
    ['invalid diamond fill', { commands: [[2, 100, 100, 2, 0, true]] }],
  ])('rejects %s without producing a partial scene', (_label, patch) => {
    expect(() => parse({ ...snapshot(), ...patch })).toThrow();
  });

  it('matches firmware integer-token rules and the raw 4 KiB limit', () => {
    const body = JSON.stringify(snapshot());
    expect(() => parseDisplaySnapshotText(body.replace('"width":400', '"width":400.0'))).toThrow();
    expect(() => parseDisplaySnapshotText(body.replace('"width":400', '"width":4e2'))).toThrow();
    expect(() => parseDisplaySnapshotText(' '.repeat(4097))).toThrow(/4 KiB/);
    expect(() => parseDisplaySnapshotText(`${body} trailing`)).toThrow();
    expect(() => parseDisplaySnapshotText(`\ufeff${body}`)).toThrow();
    expect(() => parseDisplaySnapshotText('')).toThrow();
    expect(parse({ ...snapshot(), commands: [[1, 0, 0, 0, 0, '']] }).commands).toHaveLength(1);
  });
});
