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

test('chat-only evidence includes both speakers and a changed source reply invalidates a cached digest', async () => {
  const inputs = [];
  const synthesize = createDailySynthesis({fetcher: async (_url, options) => {
    inputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    return Response.json({choices:[{message:{content:JSON.stringify({
      summary:'讨论了极限的定义。', sourceNumbers:[1], suggestion:'',
    })}}]});
  }});
  const review = {date:'2026-11-18', observations:[], workActivities:[{
    title:'数学复习', completedItems:[], events:[{at:'2026-11-18T02:05:00Z', kind:'discussion',
      text:'这个怎么理解？', source:'ChatGPT', evidence:'提问：这个怎么理解？\n回复：用极限的定义。'}],
  }]};
  const first = await synthesize(review);
  assert.equal(first.evidence[0].sourceLabel,'ChatGPT');
  assert.match(inputs[0][0].excerpt,/用极限的定义/);
  review.workActivities[0].events[0].evidence += ' 先固定 ε。';
  const second = await synthesize(review);
  assert.equal(inputs.length,2);
  assert.notEqual(first.observationRevision,second.observationRevision);
});

test('same-numbered problems on different worksheets retain their own status and sources in the daily narrative', async () => {
  const { synthesisEvidence } = await import('../../contracts/daily-synthesis.ts');
  const { createHash } = await import('node:crypto');
  const at = minute => new Date(Date.UTC(2026,10,18,2,minute)).toISOString();
  const event = (i,kind,text,source='屏幕记录') => ({at:at(i),kind,text,source,evidence:text});
  const completed = ['Problem 1','Problem 3'].map(label=>({document:'Week 3 Homework',label}));
  const answered = ['Problem 1','Problem 3'].map(label=>({document:'Week 4 Practice',label}));
  const events = [
    event(0,'work','查看《Week 3 Homework》 · 有完成标记：Problem 1、Problem 3'),
    event(15,'work','查看《Week 4 Practice》 · 可见作答：Problem 1、Problem 3'),
    event(16,'reading','查看《Chapter One.pptx》 · Limits of sequences'),
    event(17,'discussion','提问「怎样用 ε 和 N 说明数列收敛？」','ChatGPT'),
  ];
  const review = {date:'2026-11-18',observations:Array.from({length:14},(_,i)=>({
    id:'old-'+i,at:at(i+1),summary:'一条其他屏幕观察',source:'automatic',
  })),workActivities:[{title:'数学',completedItems:completed,answeredItems:answered,events}]};
  const synthesize = createDailySynthesis({fetcher:()=>assert.fail('a model cannot reassign verified outcome evidence')});
  const output = await synthesize(review);
  assert.equal(output.method,'recorded');
  const sentences = output.summary.split('。');
  assert.match(sentences[0],/《Week 3 Homework》.*2 项带有完成标记（Problem 1、Problem 3）/);
  assert.doesNotMatch(sentences[0],/可见作答|Week 4|已提交/);
  assert.match(sentences[1],/《Week 4 Practice》.*可见 2 项作答（Problem 1、Problem 3）/);
  assert.doesNotMatch(sentences[1],/完成标记|Week 3|已提交/);
  assert.match(sentences[2],/先查看《Chapter One.pptx》.*随后是 ChatGPT 对话.*ε 和 N/);
  assert.equal(output.suggestion,'');
  assert.equal(output.total,18);
  assert.equal(output.used,4);
  assert.deepEqual(output.evidence.map(r=>r.at),events.map(e=>e.at));
  const revision = createHash('sha256').update(JSON.stringify([review.date,synthesisEvidence(review)])).digest('hex');
  assert.equal(output.observationRevision,revision);
  const corrected = structuredClone(review);
  corrected.workActivities[0].answeredItems.pop();
  const revised = await synthesize(corrected);
  assert.notEqual(revised.observationRevision,revision);
  assert.match(revised.summary,/《Week 4 Practice》.*可见 1 项作答（Problem 1）/);
});
