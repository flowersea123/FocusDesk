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

test('identical pending and completed day snapshots share inference; dates and observation edits invalidate it', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const synthesize = createDailySynthesis({ fetcher: async () => {
    calls++;
    await gate;
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: '屏幕显示论文方法页。', sourceNumbers: [1], suggestion: '继续读实验。',
    }) } }] });
  } });
  const review = { date: '2026-11-16', observations: [{
    id: 'same', at: '2026-11-16T02:40:00Z', summary: '阅读论文方法页', source: 'automatic', nextStep: '读实验',
  }] };
  const first = synthesize(review);
  const duplicate = synthesize(structuredClone(review));
  assert.equal(calls, 1);
  await assert.rejects(synthesize({ ...review, date: '2026-11-17' }), { status: 429 });
  release();
  const result = await first;
  assert.deepEqual(await duplicate, result);
  assert.deepEqual(await synthesize(structuredClone(review)), result);
  assert.equal(calls, 1);
  assert.match(result.observationRevision, /^[a-f0-9]{64}$/);
  for (const changed of [
    { ...review, date: '2026-11-17' },
    { ...review, observations: [{ ...review.observations[0], nextStep: '读图表' }] },
    { ...review, observations: [{ ...review.observations[0], source: 'manual' }] },
  ]) {
    const revised = await synthesize(changed);
    assert.notEqual(revised.observationRevision, result.observationRevision);
  }
  assert.equal(calls, 4);
});

test('the same observations can be retried when inference recovers', async () => {
  let offline = true;
  const synthesize = createDailySynthesis({ fetcher: async () => offline ? new Response(null, { status: 503 }) :
    Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '正在校对。', sourceNumbers: [1], suggestion: '' }) } }] }) });
  const review = { date: '2026-11-16', observations: [{ at: '2026-11-16T05:00:00Z', summary: '校对摘要' }] };
  await assert.rejects(synthesize(review), { status: 503 });
  offline = false;
  assert.equal((await synthesize(review)).summary, '正在校对。');
});
