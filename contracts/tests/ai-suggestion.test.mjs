import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyOverview } from '../daily-overview.ts';
import { MAX_AI_SUGGESTION_LENGTH, parseAISuggestionUpdateRequest, parseAISuggestionUpdateText } from '../ai-suggestion.ts';

const base = { schema_version: '1.0', revision: 'base', date: '2026-11-12', timezone: 'UTC', updated_at: '2026-11-12T10:00:00.000Z', tasks: [] };

test('AI suggestion accepts optional legacy data, Unicode, line breaks and explicit clearing', () => {
  assert.deepEqual(parseDailyOverview(base), base);
  for (const suggestion of ['', '先列出提纲。\nFocus for 25 minutes. 😀', 'a'.repeat(MAX_AI_SUGGESTION_LENGTH)]) {
    const request = { revision: 'base', ai_suggestion: suggestion };
    assert.deepEqual(parseAISuggestionUpdateText(JSON.stringify(request)), request);
    assert.equal(parseDailyOverview({ ...base, ai_suggestion: suggestion }).ai_suggestion, suggestion);
  }
});

test('AI suggestion rejects over-limit text, controls, invalid Unicode and invalid write shapes', () => {
  for (const suggestion of [null, 1, 'a'.repeat(121), '\u0000', '\t', '\u007f', '\ud800', '\udfff']) {
    assert.throws(() => parseDailyOverview({ ...base, ai_suggestion: suggestion }));
    assert.throws(() => parseAISuggestionUpdateRequest({ revision: 'base', ai_suggestion: suggestion }));
  }
  for (const input of [null, [], {}, { ai_suggestion: 'hello' }, { revision: ' ' , ai_suggestion: '' },
    { revision: 'base', ai_suggestion: '', tasks: [] }]) assert.throws(() => parseAISuggestionUpdateRequest(input));
  assert.throws(() => parseAISuggestionUpdateText('{'));
  assert.throws(() => parseAISuggestionUpdateText(' '.repeat(4097)));
});
