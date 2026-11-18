import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCheckpointStore } from '../src/checkpoint-store.ts';

test('confirmed observations survive restart and concurrent saves, and contain no original image', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-observations-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'tasks.json');
  const store = createCheckpointStore(file);
  const row = { id: randomUUID(), capturedAt: new Date().toISOString(), taskId: 'a', summary: '编译了三个模块', nextStep: '检查第四个模块', progress: { percent:75, evidence:'Modules compiled: 3/4' } };
  await Promise.all([store.add({ ...row, image:'SECRET_RAW_PIXELS' }), store.add(row), store.add({ ...row, id:randomUUID(), taskId:null, progress:null })]);
  assert.equal((await createCheckpointStore(file).read()).records.length,2);
  assert.doesNotMatch(await readFile(file+'.checkpoints.json','utf8'),/SECRET_RAW_PIXELS/);
  await assert.rejects(store.add({ ...row, summary: '不同内容' }), {status:409});
  await store.remove(row.id);
  await store.remove(row.id);
  assert.equal((await store.read()).records.length,1);
  assert.throws(()=>store.add({ ...row, taskId:null }), {status:400});
  await writeFile(file+'.checkpoints.json','broken');
  await assert.rejects(store.read(), {status:503});
  await assert.rejects(store.add(row), {status:503});
  assert.equal(await readFile(file+'.checkpoints.json','utf8'), 'broken');
});

test('keeps manual and automatic origin after restart and deletion, treating old records as reviewed', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-sources-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'tasks.json');
  const old = { id:randomUUID(), capturedAt:'2026-11-16T01:00:00.000Z', taskId:'paper', summary:'Reading the paper', nextStep:'', progress:null };
  await writeFile(file + '.checkpoints.json', JSON.stringify({version:1, records:[old]}));
  const store = createCheckpointStore(file);
  await store.add({...old, source:'manual'});
  const auto = {...old, id:randomUUID(), source:'automatic', completedParts:['Introduction']};
  await store.add(auto);
  const restarted = createCheckpointStore(file);
  assert.deepEqual((await restarted.read()).records.map(r => r.source), ['manual','automatic']);
  assert.throws(() => store.add({...auto, source:'unknown'}), {status:400});
  assert.throws(() => store.add({...auto, taskId:null}), {status:400});
  await restarted.remove(auto.id);
  assert.deepEqual((await store.read()).records.map(r => r.id), [old.id]);
});

test('reading confirmations require a saved matching bookmark, survive retries and preserve the original source', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-reading-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'tasks.json');
  const store = createCheckpointStore(file);
  const input = {id:randomUUID(),capturedAt:'2026-11-16T00:00:00.000Z',source:'automatic',taskId:'paper',
    summary:'阅读论文正文',nextStep:'',completedParts:[],progress:null,readingDocument:'A Paper',readingSection:'Introduction'};
  await store.add(input);
  assert.throws(() => store.add({...input,readingConfirmed:true}), {status:400});
  assert.throws(() => store.add({...input,readingSection:''}), {status:400});
  assert.throws(() => store.add({...input,readingDocument:'A\nPaper'}), {status:400});
  assert.throws(() => store.add({...input,source:'manual',taskId:null}), {status:400});
  await assert.rejects(store.confirmReading(input.id,'Different section'), {status:409});
  await Promise.all([store.confirmReading(input.id,'Introduction'),store.confirmReading(input.id,'Introduction')]);
  await store.add(input);
  const rows = (await createCheckpointStore(file).read()).records;
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0],{...input,readingConfirmed:true});
  await store.remove(input.id);
  await assert.rejects(store.confirmReading(input.id,'Introduction'), {status:409});
});

test('page position survives restart with its document and never counts as completed work', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-reading-page-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'tasks.json');
  const row = {id:randomUUID(), capturedAt:new Date().toISOString(), source:'automatic', taskId:'paper',
    summary:'正在阅读论文正文', nextStep:'', progress:null, readingDocument:'A paper', readingPosition:{page:6,total:12}};
  const store = createCheckpointStore(file);
  for (const bad of [{page:0,total:10}, {page:10,total:8}, {page:1.5,total:2}, {page:1,total:100001}, {}]) {
    assert.throws(() => store.add({...row,readingPosition:bad}), {status:400});
  }
  assert.throws(() => store.add({...row,readingDocument:undefined}), {status:400});
  assert.throws(() => store.add({...row,taskId:null,appName:'Preview'}), {status:400});
  await store.add(row);
  const [saved] = (await createCheckpointStore(file).read()).records;
  assert.deepEqual(saved.readingPosition, {page:6,total:12}); assert.deepEqual(saved.completedParts, []);
  assert.equal(saved.progress, null); assert.equal(saved.readingConfirmed, undefined);
});


test('unassigned activity evidence survives restart independently of task achievements', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'focusdesk-daily-work-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'tasks.json'), store=createCheckpointStore(file);
  const row={id:randomUUID(),capturedAt:new Date().toISOString(),source:'automatic',appName:'Browser',taskId:null,
    summary:'作业状态',progress:null,nextStep:'',activityEvidence:{kind:'work',title:'Problem Set 4',subject:'Discrete Mathematics',answeredItems:['Q3'],completedItems:['Q1','Q2']}};
  await store.add(row);
  const {records:[saved]}=await createCheckpointStore(file).read();
  assert.deepEqual(saved.activityEvidence,row.activityEvidence);
  assert.deepEqual(saved.completedParts,[]);
  assert.throws(()=>store.add({...row,detailSource:'window-title'}),{status:400});
  assert.throws(()=>store.add({...row,activityEvidence:{...row.activityEvidence,kind:'reading'}}),{status:400});
  assert.throws(()=>store.add({...row,activityEvidence:{...row.activityEvidence,completedItems:['']}}),{status:400});
  assert.throws(()=>store.add({...row,activityEvidence:{...row.activityEvidence,answeredItems:[{value:'not an item'}]}}),{status:400});
  assert.throws(()=>store.add({...row,activityEvidence:{...row.activityEvidence,extra:'unbounded data'}}),{status:400});
});
