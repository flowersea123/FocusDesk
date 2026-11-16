import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOutlookWorker } from '../outlook-worker.mjs';

async function config(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(),'FocusDesk 同步 '));
  t.after(() => rm(stateDir,{recursive:true,force:true}));
  const date = '2026-11-14T00:00:00Z';
  return { stateDir, now: () => Date.parse(date),
    getSession: async () => ({ accountId:'one', accessToken:'private-test-token', connectedAt:date }),
    readPage: async () => ({cursor:{phase:'incremental'},hasMore:false,messages:['a','b'].map(id => ({id,graphId:id,receivedDateTime:date}))}),
    readMail: async ({message}) => ({id:message.id,subject:message.id,body:'private-body',images:[]}),
    analyze: async mail => ({summary:'summary '+mail.id}),
    assess: mail => [{sourceKey:'key-'+mail.id,dueAt:'2026-11-16T00:00:00Z',title:'Submit '+mail.id,reason:null}],
  };
}

test('queued pages, analyses and successful source receipts survive restart and isolate accounts', async t => {
  const setup = await config(t), writes = [], analyses = [];
  let fail = true;
  const opts = { ...setup, analyze: async mail => { analyses.push(mail.id); if(mail.id==='a' && fail) throw Error(); return setup.analyze(mail); },
    save: async ({sourceKey}) => {writes.push(sourceKey);return {status:fail?'full':'added'};} };
  let worker = createOutlookWorker(opts);
  let state = await worker.sync();
  assert.equal(state.pendingCount,2);
  assert.equal(state.history.find(r=>r.id==='b').summary,'summary b');
  await worker.stop();
  fail = false;
  worker = createOutlookWorker(opts);
  state = await worker.sync();
  assert.deepEqual(analyses,['a','b','a']);
  assert.equal(state.counts.added,2); assert.equal(state.pendingCount,0);
  const count = writes.length;
  await worker.sync();
  assert.equal(writes.length,count);
  await worker.stop();
  const disk=await readFile(path.join(setup.stateDir,(await readdir(setup.stateDir))[0]),'utf8');
  assert.ok(!disk.includes('private-body') && !disk.includes('private-test-token'));
  const second=createOutlookWorker({...opts,getSession:async()=>({accountId:'two',accessToken:'another'}),readPage:async opts=>{
    assert.equal(opts.cursor,null); return {cursor:{phase:'incremental'},hasMore:false,messages:[]};}});
  assert.equal((await second.sync()).counts.messages,0);
  await second.stop();
});

test('a single flight handles forced refresh, throttle, and an expired cursor from the original connection', async t=>{
  const setup=await config(t), calls=[];
  let step=0, time=Date.parse('2026-11-14T01:00:00Z');
  const worker=createOutlookWorker({...setup,now:()=>time,
    getSession:async({forceRefresh})=>({...await setup.getSession(),accessToken:forceRefresh?'new':'old'}),
    readPage:async ({cursor,accessToken,since})=>{
      calls.push({cursor,accessToken,since});step++;
      if(step===1)throw Object.assign(Error(),{status:401});
      if(step===3)throw Object.assign(Error(),{status:429,retryAfterMs:5000});
      if(step===4)throw Object.assign(Error(),{status:410});
      return {cursor:{phase:'incremental'},hasMore:false,messages:[]};
    }});
  const both=await Promise.all([worker.sync(),worker.sync()]);
  assert.equal(both[0].phase,'incremental'); assert.equal(calls.length,2);assert.equal(calls[1].accessToken,'new');
  assert.equal((await worker.sync()).phase,'error');
  await worker.sync();assert.equal(calls.length,3);
  time+=6000;assert.equal((await worker.sync()).phase,'incremental');
  assert.equal(calls.length,5);assert.equal(calls[4].cursor,null);assert.equal(calls[4].since,calls[0].since);
  await worker.stop();assert.equal(worker.status().connected,false);
});

test('old history, including messages beyond the first 60 and reading-only mail, can be planned without rereading Graph or the model', async t => {
  const setup = await config(t);
  const { createHash } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const messages = Array.from({ length: 65 }, (_, i) => ({
    id: 'history-' + i, receivedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    subject: '课程通知 ' + i, summary: '已有的同步历史', status: 'processed', actions: i ? [] :
      [{ sourceKey: 'mail:old:confirmed', dueAt: '2026-11-27T10:00:00Z', title: 'Submit lab', status: 'added' }],
  }));
  await writeFile(path.join(setup.stateDir, 'outlook-' + createHash('sha256').update('one').digest('hex') + '.json'),
    JSON.stringify({ version: 1, since: '2026-10-01T00:00:00Z', cursor: { phase: 'incremental' }, graphAfter: 0, receipts: {}, messages }));
  const writes = [];
  const worker = createOutlookWorker({ ...setup, readPage: async () => ({ messages: [], hasMore: false, cursor: { phase: 'incremental' } }),
    readMail: () => assert.fail('should not fetch old MIME'), analyze: () => assert.fail('should not re-analyze history'),
    calendar: async () => ({ entries: [], timezone: 'Asia/Shanghai' }), save: async data => { writes.push(data); return { status: 'added' }; } });
  await worker.sync();
  assert.equal((await worker.history()).history.length, 60);
  const full = await worker.history(120);
  assert.equal(full.historyCount, 65); assert.equal(full.history.length, 65);
  for (const messageId of ['history-0', 'history-1']) {
    const action = full.history.find(row => row.id === messageId).actions[0];
    await worker.plan({ messageId, actionId: action.id, plannedDate: '2026-11-17' });
  }
  assert.equal(writes[0].sourceKey, 'mail:old:confirmed');
  assert.equal(writes[0].dueDate, '2026-11-27');
  assert.equal(writes[1].dueAt, null); assert.equal(writes[1].dueDate, null);
  assert.equal(writes[1].plannedDate, '2026-11-17');
  await worker.stop();
});
