import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointCapacityError } from '../src/checkpoint-store.ts';
import { createForegroundRecorder } from '../src/foreground-recorder.ts';
import { WriteRequestError } from '../src/write-policy.ts';

async function until(condition) {
  const deadline = Date.now() + 2500;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for recorder state');
    await delay(3);
  }
}
const result = summary => ({ summary, nextStep: '', taskId: null, progress: null, completedParts: [] });
const frame = (page, image = page, app = 'Fixture Browser') => ({ pageKey: page, pageTitle: page, image, app });
const supported = async () => ({ supported: true, message: '' });

test('changing the task mid-inference uses capture-time context and identifies a fresh frame from the same window', async t => {
  let resolveFirst, current = frame('same'), closes = 0;
  const targets = [], saved = [];
  const recorder = createForegroundRecorder({ platform:'darwin', support:supported, pollMs:3, samePageMs:5,
    open:async () => ({capture:async () => current, close() { closes++; }}),
    analyze:async (image, signal, target) => {
      targets.push(target); if (targets.length === 1) await new Promise(ok => {resolveFirst = ok});
      return {...result(image),taskId:image === 'news' ? null : target};
    }, save:async r => { saved.push(r); } });
  t.after(() => { resolveFirst?.(); return recorder.close(); });
  assert.throws(() => recorder.target('t1'), {status:409});
  recorder.start('t1'); await until(() => !!resolveFirst);
  assert.equal(recorder.target('t2').observedTaskId, null); resolveFirst();
  await until(() => saved.length === 2);
  assert.deepEqual(saved.map(r=>r.taskId), ['t1','t2']);
  assert.equal((await recorder.readStatus()).observedTaskId,'t2');
  current = frame('news');
  await until(() => saved.length === 3);
  assert.equal((await recorder.readStatus()).observedTaskId,null);
  assert.ok((await recorder.readStatus()).observedAt);
  await recorder.close(); assert.equal(closes,1);
  assert.equal((await recorder.readStatus()).targetTaskId,null);
});

test('start is explicit and idempotent; tab, active app and within-page changes follow the foreground only', async t => {
  let current = frame('First tab'), stops = 0, starts = 0, menuStop;
  const analyzed = [], rows = [];
  const recorder = createForegroundRecorder({ platform: 'darwin', support: supported, pollMs: 4, samePageMs: 10,
    open: async ({ onStop }) => { starts++; menuStop = onStop; return { capture: async () => current, close: () => { stops++; } }; },
    analyze: async image => { analyzed.push(image); return result(image); }, save: async row => { rows.push(row); } });
  t.after(() => recorder.close());
  assert.equal((await recorder.readStatus()).state, 'idle');
  assert.equal(starts, 0);
  recorder.start(); recorder.start();
  await until(() => rows.length === 1);
  await delay(32);
  assert.deepEqual(analyzed, ['First tab']);
  current = frame('Second tab');
  await until(() => rows.length === 2);
  current = null;
  await delay(12);
  current = frame('Paper.pdf', 'Introduction', 'PDF Viewer');
  await until(() => rows.length === 3);
  current = frame('Paper.pdf', 'Method', 'PDF Viewer');
  await until(() => rows.length === 4);
  menuStop();
  await until(async () => (await recorder.readStatus()).state === 'idle');
  current = frame('After stopping');
  await delay(20);
  assert.equal(starts, 1); assert.equal(stops, 1);
  assert.deepEqual(rows.map(r => [r.appName, r.summary]), [
    ['Fixture Browser', 'First tab'], ['Fixture Browser', 'Second tab'], ['PDF Viewer', 'Introduction'], ['PDF Viewer', 'Method'],
  ]);
  for (const entry of rows) { assert.equal(entry.taskId, null); assert.equal(entry.source, 'automatic'); assert.equal(entry.image, undefined); }
  assert.equal((await recorder.readStatus()).savedCount, 4);
});

test('queued samples continue observing other apps while inference is slow and discard late results on stop', async t => {
  let current = frame('one'), captured, finish;
  const analyzed = [], saved = [];
  const recorder = createForegroundRecorder({ platform: 'win32', support: supported, pollMs: 3, samePageMs: 5,
    open: async () => ({ capture: async () => { captured = current.image; return current; }, close() {} }),
    analyze: async image => {
      analyzed.push(image);
      if (image === 'one' || image === 'end') await new Promise(resolve => { finish = resolve; });
      return result(image);
    }, save: async row => { saved.push(row.summary); } });
  t.after(() => { finish?.(); return recorder.close(); });
  recorder.start();
  await until(() => analyzed.length === 1);
  current = frame('two'); await until(() => captured === 'two');
  current = frame('three'); await until(() => captured === 'three');
  finish();
  await until(() => saved.length === 3);
  assert.deepEqual(saved, ['one', 'two', 'three']);
  current = frame('end'); await until(() => analyzed.at(-1) === 'end');
  recorder.stop(); recorder.stop(); finish();
  await recorder.close();
  assert.deepEqual(saved, ['one', 'two', 'three']);
});

test('a settled page turn within the same PDF skips the animation backoff, moving frames do not', async t => {
  let page = 'Introduction', index = 0;
  const summaries = [];
  const recorder = createForegroundRecorder({ platform: 'darwin', support: supported, pollMs: 4, samePageMs: 45_000,
    open: async () => ({ capture: async () => frame('paper.pdf', page || 'Animation ' + ++index), close() {} }),
    analyze: async image => result(image), save: async row => { summaries.push(row.summary); } });
  t.after(() => recorder.close());
  recorder.start();
  await until(() => summaries.length === 1);
  page = ''; await until(() => index >= 5);
  assert.deepEqual(summaries, ['Introduction']);
  page = 'Method'; await until(() => summaries.length === 2);
  assert.deepEqual(summaries, ['Introduction', 'Method']);
});

test('model downtime leaves a labeled title record for each new page, without task credit', async t => {
  let current = frame('First page');
  let available = false;
  const saved = [];
  const recorder = createForegroundRecorder({ platform: 'linux', support: supported, pollMs: 3, samePageMs: 5,
    open: async () => ({ capture: async () => current, close() {} }),
    analyze: async () => {
      if (!available) throw new WriteRequestError(503, 'MODEL_UNAVAILABLE', 'offline');
      return { taskId: null, summary: 'A page is visible.', nextStep: '', progress: null };
    },
    save: async row => { saved.push(row); } });
  t.after(() => recorder.close());
  recorder.start();
  await until(() => saved.length === 1);
  current = frame('First page', 'changed pixels');
  await delay(25);
  assert.equal(saved.length, 1);
  current = frame('Second page');
  await until(() => saved.length === 2);
  assert.deepEqual(saved.map(r => r.pageTitle), ['First page', 'Second page']);
  assert.match(saved[0].summary, /前台页面标题为「First page」/);
  assert.ok(saved.every(r => r.detailSource === 'window-title' && !r.progress && r.taskId === null));
  assert.match((await recorder.readStatus()).message, /只记录窗口标题/);
  available = true;
  current = frame('Third page');
  await until(() => saved.length === 3);
  assert.equal((await recorder.readStatus()).message, '');
});

test('unsupported desktops and permission errors stay stopped; cancelling startup disposes its late helper', async () => {
  let allowed = false, late, closes = 0;
  const options = { platform: 'darwin', support: supported, analyze: async () => assert.fail(), save: async () => assert.fail() };
  const unavailable = createForegroundRecorder({ ...options, support: async () => ({ supported: false, message: 'Wayland' }),
    open: async () => assert.fail() });
  assert.equal((await unavailable.readStatus()).state, 'unavailable');
  unavailable.start();
  await until(async () => (await unavailable.readStatus()).state === 'unavailable');
  const recorder = createForegroundRecorder({ ...options, open: async () => {
    if (!allowed) throw new Error('需要屏幕录制授权');
    await new Promise(resolve => { late = resolve; });
    return { capture: async () => assert.fail(), close: () => { closes++; } };
  } });
  recorder.start();
  await until(async () => (await recorder.readStatus()).state === 'error');
  assert.match((await recorder.readStatus()).message, /授权/);
  allowed = true; recorder.start(); await until(() => late);
  assert.equal(recorder.stop().state, 'stopping'); late();
  await recorder.close();
  assert.equal(closes, 1); assert.equal((await recorder.readStatus()).state, 'idle');
});

test('same-app samples measure foreground intervals through deduplication, but never bridge sleep or lock', async t => {
  const frames = [[0,'A'],[4000,'A'],[8000,'B'],[12000,'B'],[16000,null],[20000,'B'],[24000,'B'],[120000,'B'],[124000,'B']];
  const spans = [];
  let at = 0;
  const recorder = createForegroundRecorder({ platform:'darwin', support:supported, pollMs:2, now:() => at,
    open:async () => ({ capture:async () => {
      const pair = frames.shift();
      if (!pair) return null;
      at = pair[0];
      return pair[1] ? frame(pair[1], 'same-pixels', pair[1]) : null;
    }, close() {} }),
    analyze:async () => result('Stable content'), save:async () => {},
    recordAppSpan:async (app, from, to) => { spans.push([app, from, to]); },
  });
  t.after(() => recorder.close()); recorder.start();
  await until(() => spans.length === 4);
  assert.deepEqual(spans, [['A',0,4000],['B',8000,12000],['B',20000,24000],['B',120000,124000]]);
});

test('a full checkpoint store keeps app and AI tracking live and retries the same page after space is freed', async t => {
  let now = 4_000, page = 'First', full = false, appThrough = 0, aiThrough = 0, attempts = 0;
  const saved = [];
  const recorder = createForegroundRecorder({
    platform: 'linux', support: supported, pollMs: 2, now: () => now,
    open: async () => ({ capture: async () => frame(page), close() {} }),
    analyze: async image => result(image),
    save: async row => {
      attempts++;
      if (full) throw new CheckpointCapacityError();
      saved.push(row.pageTitle);
    },
    recordAppSpan: async (_app, _from, to) => { appThrough = to; },
    monitorAi: async signal => {
      while (!signal.aborted) { aiThrough = now; await delay(2); }
    },
  });
  t.after(() => recorder.close());
  recorder.start();
  await until(() => saved.length === 1);
  full = true; page = 'Second'; now = 8_000;
  await until(async () => (await recorder.readStatus()).message.includes('已满'));
  now = 12_000;
  await until(() => appThrough === now && aiThrough === now);
  assert.equal((await recorder.readStatus()).state, 'recording');
  assert.equal(attempts, 2);
  assert.deepEqual(saved, ['First']);

  full = false; now = 68_000;
  await until(() => saved.length === 2);
  assert.deepEqual(saved, ['First', 'Second']);
  assert.equal((await recorder.readStatus()).message, '');
});

test('saves verified paper/page changes while another capture awaits the model, then adds a visible section', async t => {
  let current = frame('Unrelated app'), release, attempt = 0;
  const rows = [];
  const recorder = createForegroundRecorder({platform:'darwin', support:supported, pollMs:3,
    open:async () => ({capture:async () => current, close() {}}),
    analyze:async image => {
      if (image === 'Unrelated app') await new Promise(resolve => { release = resolve; });
      if (image === 'PDF2') return {...result('PDF'),taskId:'read',readingSection:'Background'};
      return result(image);
    },
    identifyPaper:async () => ({title:'Attention Is All You Need',taskId:'read'}),
    save:async row => {rows.push(row);},
    now:() => Date.UTC(2026,10,17,0,0,attempt++) });
  t.after(() => {release?.();return recorder.close();});
  recorder.start(); await until(() => !!release);
  const id='1706.03762';
  const show = (paper, image) => {
    current = {...frame('Chrome window',image,'Google Chrome'),paper};
  };
  show({id,view:'abstract',title:'Attention Is All You Need'},'abstract');
  await until(() => rows.length >= 1);
  show({id,view:'pdf',position:{page:1,total:15}},'PDF1');
  await until(() => rows.length >= 2);
  show({id,view:'pdf',position:{page:2,total:15}},'PDF2');
  await until(() => rows.length >= 3);
  assert.deepEqual(rows.map(row => [row.taskId,row.paper.id,row.paper.position?.page]),[
    ['read',id,undefined],['read',id,1],['read',id,2]]);
  const latest=(await recorder.readStatus()).lastSavedAt;
  release();
  await until(() => rows.some(row => row.readingSection === 'Background'));
  const status=await recorder.readStatus();
  assert.ok(status.lastSavedAt >= latest);
  assert.equal(status.observedTaskId,'read');
  assert.ok(rows.every(row => !row.completedParts?.length));
});

test('offline paper metadata survives unreadable frames and terminal titles do not become paper visits', async t => {
  const id='1706.03762';
  let current = frame(id + '.pdf','terminal-pdf','Terminal');
  const rows = [];
  const recorder = createForegroundRecorder({platform:'darwin',support:supported,pollMs:3,
    open:async () => ({capture:async()=>current, close() {}}),
    analyze:async () => {throw new WriteRequestError(503,'MODEL_UNAVAILABLE','offline');},
    identifyPaper:async () => ({title:'Attention Is All You Need',taskId:'read'}),
    save:async row => {rows.push(row);} });
  t.after(() => recorder.close());
  recorder.start(); await until(() => rows.length === 1);
  assert.equal(rows[0].paper,undefined);
  assert.equal(rows[0].taskId,null);
  current = {...frame(id + '.pdf','page2','Google Chrome'),paper:{id,view:'pdf',position:{page:2,total:15}}};
  await until(() => rows.length === 2);
  await delay(20);
  assert.equal(rows.length,2);
  assert.deepEqual(rows[1].readingPosition,{page:2,total:15});
  assert.equal(rows[1].readingDocument,'Attention Is All You Need');
  const other='1810.04805';
  current = {...current, paper:{id:other,view:'pdf',title:'Second paper',position:{page:2,total:15}}};
  await until(() => rows.length === 3);
  assert.equal(rows[2].paper.id,other);
  assert.equal(rows[2].readingDocument,'Second paper');
});


test('same-window unplanned evidence changes save even if the description is unchanged', async t => {
  let items=['Question 1'], answered=[];
  const saved=[];
  const recorder=createForegroundRecorder({platform:'darwin',support:supported,pollMs:3,samePageMs:5,
    open:async()=>({capture:async()=>frame('assignment',items.join(',')+answered.join(',')),close(){}}),
    analyze:async()=>({...result('查看作业'),activityEvidence:{kind:'work',title:'Worksheet',completedItems:[...items],...(answered.length ? {answeredItems:answered} : {})}}),
    save:async row=>{saved.push(row)}});
  t.after(()=>recorder.close());
  recorder.start();
  await until(()=>saved.length===1);
  items=['Question 1','Question 2'];
  await until(()=>saved.length===2);
  items=['Question 2','Question 1'];
  await delay(40);
  assert.equal(saved.length,2);
  assert.deepEqual(saved[1].activityEvidence.completedItems,['Question 1','Question 2']);
  assert.equal(saved[1].taskId,null);
  answered=['Question 5'];
  await until(()=>saved.length===3);assert.deepEqual(saved[2].activityEvidence.answeredItems,answered);
});
