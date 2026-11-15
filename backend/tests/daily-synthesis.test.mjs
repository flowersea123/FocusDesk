import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailySynthesis } from '../src/daily-synthesis.ts';

test('synthesis samples the whole day and binds cited numbers to stored observations', async () => {
  const observations = Array.from({ length: 25 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 10, 16, 0, i)).toISOString(), summary: 'record-' + i, source: i ? 'automatic' : 'manual',
  }));
  let input;
  const synthesize = createDailySynthesis({ fetcher: async (_url, options) => {
    input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return Response.json({choices:[{message:{content:JSON.stringify({
      summary:'整理了两段笔记。', sourceNumbers:[1,12,12], suggestion:'核对实验数据。',
    })}}]});
  }});
  const result = await synthesize({ observations });
  assert.equal(result.total, 25);
  assert.equal(result.used, 12);
  assert.equal(input.length, 12);
  assert.equal(input[0].source, '手动确认');
  assert.equal(input.at(-1).source, '自动记录');
  assert.deepEqual(result.evidence, [observations[0], observations.at(-1)]);
  await assert.rejects(synthesize({ observations: [] }), { status: 400 });
});

test('rejects unknown source references and external inference destinations', async () => {
  const observations = [{ at:new Date().toISOString(), summary:'Only one record' }];
  const fetcher = async () => Response.json({choices:[{message:{content:JSON.stringify({
    summary:'Unsupported', sourceNumbers:[2], suggestion:'',
  })}}]});
  await assert.rejects(createDailySynthesis({fetcher})({observations}),{status:503});
  let calls = 0;
  const remote = createDailySynthesis({endpoint:'https://example.org',fetcher:async () => { calls++; }});
  await assert.rejects(remote({observations}),{status:503});
  assert.equal(calls, 0);
});
