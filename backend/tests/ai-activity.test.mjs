import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFocusReview } from '../src/focus-review.ts';
import { createForegroundRecorder } from '../src/foreground-recorder.ts';
import { monitorAiActivity } from '../src/ai-activity.ts';

const midnight = Date.parse('2026-11-17T00:00:00+08:00');
const iso = ms => new Date(midnight + ms).toISOString();
const event = (runId, ms, state = 'running') => ({
  runId, appName: runId === 'gpt' ? 'ChatGPT' : 'Codex', title: 'Run ' + runId,
  at: midnight + ms, state,
});
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-ai-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  let clock = midnight - 10_000;
  const now = () => clock;
  const make = () => createFocusReview(file, { now });
  const review = make();
  return {
    file, review, make, now, clock(ms) { clock = midnight + ms; },
    async batch(from, at, events, reset = false) {
      clock = midnight + at;
      await review.aiActivity.record(events, midnight + from, clock, reset);
    },
  };
}

test('parallel runs overlap each other and the foreground across midnight, separate from human focus', async t => {
  const f = await setup(t);
  await f.batch(-10_000, -5_000, [event('code', -9000), event('gpt', -6500)]);
  await f.review.recordAppSpan('Reader', midnight - 4500, midnight + 2000);
  await f.batch(-5000, 2000, [event('gpt', 1900), event('code', -1000, 'finished')]);
  await f.batch(2000, 8000, [event('gpt', 6000, 'finished'), event('short', 4400), event('short', 4800, 'finished')]);
  const yesterday = await f.review.read('2026-11-16');
  const today = await f.review.read('2026-11-17');
  assert.deepEqual(yesterday.aiSessions.map(({ runId, from, to }) => [runId, from, to]), [
    ['code', iso(-9000), iso(-1000)], ['gpt', iso(-6500), iso(0)],
  ]);
  assert.deepEqual(today.aiSessions.map(({ runId, from, to, state }) => [runId, from, to, state]), [
    ['gpt', iso(0), iso(6000), 'finished'], ['short', iso(4400), iso(4800), 'finished'],
  ]);
  assert.equal(today.appSessions[0].seconds, 2);
  assert.equal(today.totalSeconds, 0);
  assert.deepEqual((await f.make().read()).aiSessions, today.aiSessions);
});

test('missing evidence, sleep and restart close at the last confirmed timestamp without filling gaps', async t => {
  const f = await setup(t);
  await f.batch(0, 1000, [event('a', 500)]);
  await f.batch(1000, 1500, [event('a', 1300)]);
  f.clock(6000);
  assert.equal((await f.review.read()).aiSessions[0].to, iso(1300));
  await f.batch(1500, 6500, []);
  await f.batch(6500, 8000, [event('a', 7500)]);
  await f.batch(80_000, 80_000, [event('a', 8000), event('b', 80_000)], true);
  const spans = (await f.review.read()).aiSessions;
  assert.deepEqual(spans.map(s => [s.from, s.to, s.state]), [
    [iso(500), iso(1300), 'interrupted'], [iso(7500), iso(7500), 'interrupted'], [iso(80_000), iso(80_000), 'running'],
  ]);
  f.clock(180_000);
  const reopened = (await f.make().read()).aiSessions;
  assert.equal(reopened[2].to, iso(80_000)); assert.equal(reopened[2].state, 'interrupted');
});

test('ignores replay and unknown fields; a late authoritative end corrects the last active sample', async t => {
  const f = await setup(t);
  const first = { ...event('c', 1200), text:'raw private conversation', image:'private capture' };
  await f.batch(0, 2000, [first, event('c', 1700)]);
  await f.batch(2000, 4000, [event('c', 1600, 'finished'), first, event('other', 2000, 'finished')]);
  await f.batch(4000, 8000, [first, event('c', 1600, 'finished')]);
  const [row] = (await f.review.read()).aiSessions;
  assert.equal(row.to, iso(1600));
  assert.equal(row.from, iso(1200)); assert.equal(row.state, 'finished');
  const history = await readFile(f.file + '.ai-activity.json', 'utf8');
  assert.doesNotMatch(history, /private|image|conversation/);
  f.clock(91 * 86_400_000);
  assert.deepEqual((await f.review.read('2026-11-17')).aiSessions, []);
});

test('an unreadable AI history leaves the human review and original bytes available', async t => {
  const f = await setup(t);
  await writeFile(f.file + '.ai-activity.json', 'broken');
  const review = await f.review.read();
  assert.equal(review.aiUnavailable, true); assert.equal(review.totalSeconds, 0);
  await assert.rejects(f.batch(0, 1000, [event('a', 500)]));
  assert.equal(await readFile(f.file + '.ai-activity.json', 'utf8'), 'broken');
});

test('monitor starts only after capture has opened and stops without adding a capture or estimating an end', async t => {
  const f = await setup(t);
  f.clock(0);
  let resolveOpen, captures = 0, polls = 0, closes = 0;
  const opened = new Promise(r => { resolveOpen = r; });
  const recorder = createForegroundRecorder({
    platform:'darwin', support:async () => ({supported:true,message:''}), pollMs:60_000,
    open: async () => { await opened; return { capture:async () => { captures++; return null; }, close() {} }; },
    analyze:async () => assert.fail('no image'), save:async () => assert.fail('no screenshot record'),
    monitorAi:signal => monitorAiActivity({
      async poll() { polls++; f.clock(polls * 500); return [event('a', polls * 500), event('gpt', polls * 500)]; },
      close() { closes++; },
    }, f.review.aiActivity, signal, f.now, 3),
  });
  t.after(() => recorder.close());
  recorder.start(); await delay(8); assert.equal(polls, 0);
  resolveOpen();
  for (let tries=0; polls<3 && tries<200; tries++) await delay(3);
  assert.ok(polls >= 3);
  recorder.stop(); await recorder.close();
  const previous = polls;
  await delay(8); assert.equal(polls, previous);
  assert.equal(captures, 1); assert.equal(closes, 1);
  const spans = (await f.review.read()).aiSessions;
  assert.equal(spans.length, 2);
  assert.ok(spans.every(s => s.state === 'interrupted' && s.from === iso(500) && s.to === iso(previous * 500)));
});

test('repeated old heartbeats cannot bridge a long interval without fresh evidence', async t => {
  const f = await setup(t);
  await f.batch(0, 2000, [event('gpt', 1000)]);
  for (let step=6000; step<=34_000; step+=4000) await f.batch(step-4000, step, [event('gpt', 1000)]);
  await f.batch(34_000, 38_000, [event('gpt', 37_000)]);
  const spans = (await f.review.read()).aiSessions;
  assert.deepEqual(spans.map(s => [s.from, s.to, s.state]), [
    [iso(1000), iso(1000), 'interrupted'], [iso(37_000), iso(37_000), 'running'],
  ]);
});

test('local recording API feeds the private review with two runs while no images are available', async t => {
  const { createDemoServer } = await import('../src/service.ts');
  const f = await setup(t);
  await writeFile(f.file, JSON.stringify({ date:'2026-11-17', timezone:'Asia/Shanghai', tasks:[] }));
  let polls = 0, captures = 0, sourceOpened = 0;
  const server = createDemoServer({
    dataPath:f.file, distPath:path.dirname(f.file), now:f.now, aiPollMs:4,
    recorderDriver:{
      support:async () => ({supported:true,message:''}),
      open:async () => ({capture:async () => { captures++; return null; },close(){}}), pollMs:60_000,
    },
    aiSourceFactory() { sourceOpened++; return {async poll() {
      polls++;
      if (polls > 3) return [];
      f.clock(polls*1000);
      const state = polls === 3 ? 'finished' : 'running';
      return [event('code', polls*1000, state), event('gpt', polls*1000, state)];
    }}; },
  });
  server.listen(0,'127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening',resolve); server.once('error',reject); });
  t.after(async () => { await server.stopRecording(); await new Promise(resolve=>server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/';
  const read = async () => (await fetch(base + 'focus-review')).json();
  const action = async action => {
    const response = await fetch(base+'recorder', { method:'POST', headers:{Origin:new URL(base).origin,'Content-Type':'application/json'},body:JSON.stringify({action}) });
    assert.equal(response.status,200);
  };
  assert.deepEqual((await read()).aiSessions,[]); assert.equal(sourceOpened,0);
  await action('start');
  let view;
  for (let tries=0; tries<200; tries++) {
    view = await read();
    if (view.aiSessions.length === 2 && view.aiSessions.every(s => s.state === 'finished')) break;
    await delay(4);
  }
  assert.deepEqual(view.aiSessions.map(s => [s.appName,s.from,s.to,s.state]), [
    ['Codex',iso(1000),iso(3000),'finished'], ['ChatGPT',iso(1000),iso(3000),'finished'],
  ]);
  assert.equal(view.totalSeconds,0); assert.deepEqual(view.appSessions,[]);
  assert.deepEqual(view.observations,[]); assert.equal(captures,1);
  await action('stop'); await server.stopRecording();
  const lastPoll = polls; await delay(15); assert.equal(polls,lastPoll);
  const cross = await fetch(base+'focus-review', {headers:{Origin:'https://example.org'}});
  assert.equal(cross.status,403);
});

test('AI-only HTTP recording works with no screen permission, image, capability probe, or helper', async t => {
  const { createDemoServer } = await import('../src/service.ts');
  const f = await setup(t);
  await writeFile(f.file, JSON.stringify({ date:'2026-11-17', timezone:'Asia/Shanghai', tasks:[] }));
  let probes = 0, opens = 0, activeSources = 0, polls = 0, closes = 0;
  const server = createDemoServer({
    dataPath:f.file, distPath:path.dirname(f.file), now:f.now, aiPollMs:3,
    recorderDriver:{
      support:async () => { probes++; return {supported:false,message:'No screen permission'}; },
      open:async () => { opens++; throw Error('screen disabled'); },
    },
    aiSourceFactory() {
      activeSources++;
      return {
        async poll() { polls++; f.clock(polls*1000); return [event('a', polls*1000)]; },
        close() { closes++; },
      };
    },
  });
  server.listen(0,'127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening',resolve); server.once('error',reject); });
  t.after(async () => { await server.stopRecording(); await new Promise(resolve=>server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/';
  const post = body => fetch(base+'recorder', { method:'POST', headers:{Origin:new URL(base).origin,'Content-Type':'application/json'},body:JSON.stringify(body) });
  assert.equal((await post({action:'start-ai',taskId:null})).status,400);
  const started = await (await post({action:'start-ai'})).json();
  assert.equal(started.mode,'ai'); assert.equal(started.state,'recording');
  assert.equal((await (await post({action:'start'})).json()).mode,'ai');
  assert.equal((await post({action:'target', taskId:null})).status,409);
  assert.equal((await (await fetch(base+'recorder')).json()).mode,'ai');
  assert.equal(activeSources,1);
  for (let tries=0; tries<200 && polls<3; tries++) await delay(3);
  assert.ok(polls>=3);
  await post({action:'stop'}); await server.stopRecording();
  const lastPoll = polls; await delay(12); assert.equal(polls,lastPoll); assert.equal(closes,1);
  const view = await (await fetch(base+'focus-review')).json();
  assert.equal(view.aiSessions.length,1); assert.equal(view.aiSessions[0].state,'interrupted');
  assert.equal(probes,0); assert.equal(opens,0); assert.deepEqual(view.observations,[]);
});

test('preserves the final chat topic and excerpts on a terminal event and after restart', async t => {
  const f = await setup(t);
  const run = event('gpt',1000);
  await f.batch(0,1000,[{...run,conversationId:'chatgpt-local-A',userExcerpt:'如何标记时长？'}]);
  await f.batch(1000,5000,[{...event('gpt',5000,'finished'),conversationId:'chatgpt-real',conversationTitle:'时长条',
    conversationTurnId:'visible-turn',assistantExcerpt:'用起止时间画条。',toolResult:'discard'}]);
  const item = (await f.make().read()).aiSessions[0];
  assert.equal(item.conversationId,'chatgpt-real');assert.equal(item.conversationTitle,'时长条');
  assert.equal(item.conversationTurnId,'visible-turn');assert.equal(item.userExcerpt,'如何标记时长？');
  assert.equal(item.assistantExcerpt,'用起止时间画条。');assert.equal(item.state,'finished');assert.ok(!('toolResult' in item));
});
