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
