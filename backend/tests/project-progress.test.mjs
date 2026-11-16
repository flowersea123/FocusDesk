import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/service.ts';

test('checkpoint evidence drives a pinned device view and unpin restores the daily overview', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-project-'));
  const dataPath = path.join(dir, 'tasks.json');
  const task = { id: 'paper', title: 'Read paper', status: 'todo', due_at: null };
  await writeFile(dataPath, JSON.stringify({date:'2026-11-16', timezone:'Asia/Shanghai', tasks:[task]}));
  const server = createDemoServer({ dataPath, distPath:dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive:true, force:true});
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const endpoint = origin + '/api/v1/project-progress';
  const display = () => fetch(origin + '/api/v1/display-snapshot').then(r=>r.json());
  const initial = await display();
  const write = (url, method, data) => fetch(url, { method, headers:{'Content-Type':'application/json', Origin:origin}, body: JSON.stringify(data) });
  const plan = { taskId:task.id, revision:'initial', action:'plan', sections:['Introduction','Method','Results','Discussion','Conclusion'] };
  const response = await write(endpoint,'PUT',plan);
  assert.equal(response.status,200);
  const before = await response.json();
  assert.equal(before.statuses[0].percent,0);
  assert.equal((await write(endpoint,'PUT',plan)).status,409);
  const checkpoint = { id:randomUUID(), taskId:'paper', capturedAt:'2026-11-16T01:00:00.000Z', summary:'Read two sections', nextStep:'Read Results', progress:null, completedParts:['Method','Introduction'] };
  assert.equal((await write(origin+'/api/v1/checkpoints','POST',checkpoint)).status,200);
  const pinned = await (await write(endpoint,'PUT',{taskId:'paper',action:'pin',revision:before.config.revision})).json();
  assert.equal(pinned.statuses[0].percent,40);
  const snapshot = await display();
  assert.deepEqual(await display(),snapshot);
  const labels = snapshot.commands.filter(c=>c[0]===1).map(c=>c[5]);
  for (const text of ['40%','Introduction','Method']) assert.ok(labels.includes(text));
  assert.ok(!labels.includes('Results'));
  async function recordReading(minute, details = {}) {
    const row = { ...checkpoint, id:randomUUID(), readingDocument:'Example Paper', readingSection:'Results',
      completedParts:[], summary:'Results is visible.', capturedAt:`2026-11-16T01:${minute}:00.000Z`, ...details };
    assert.equal((await write(origin + '/api/v1/checkpoints', 'POST', row)).status, 200);
    return display();
  }
  const section = await recordReading('01');
  assert.notEqual(section.revision, snapshot.revision);
  const sectionLabels = section.commands.filter(c=>c[0]===1).map(c=>c[5]);
  assert.ok(sectionLabels.includes('Section: Results'));
  assert.ok(sectionLabels.includes('40%'));
  const page = await recordReading('02', { readingPosition:{page:6,total:12} });
  assert.notEqual(page.revision, section.revision);
  assert.ok(page.commands.some(c=>c[0]===1 && c[5]==='Page 6/12'));
  const repeated = await recordReading('03', { readingPosition:{page:6,total:12}, summary:'A different paragraph is visible.' });
  assert.deepEqual(repeated, page, 'new evidence at the same visible position keeps the device revision');
  const advanced = await recordReading('04', { readingPosition:{page:7,total:12} });
  assert.notEqual(advanced.revision, page.revision);
  assert.ok(advanced.commands.some(c=>c[0]===1 && c[5]==='Page 7/12'));
  assert.equal((await (await fetch(endpoint)).json()).statuses[0].percent, 40);
  assert.equal((await write(endpoint,'PUT',{taskId:'paper',action:'unpin',revision:pinned.config.revision})).status,200);
  assert.deepEqual(await display(), initial);
  const config = (await (await fetch(endpoint)).json()).config;
  const sections = Array.from({ length: 24 }, (_, i) => '文'.repeat(60) + i);
  assert.ok(Buffer.byteLength(JSON.stringify(sections)) > 4096);
  assert.equal((await write(endpoint, 'PUT', { ...plan, sections, revision: config.revision })).status, 200);
});
