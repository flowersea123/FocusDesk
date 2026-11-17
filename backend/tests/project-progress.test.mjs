import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
  const toggleStep = async (revision,section,done) => write(endpoint,'PUT',{taskId:'paper',action:'set-step',revision,section,done});
  let revision = pinned.config.revision;
  assert.equal((await toggleStep(revision,'Missing',true)).status,400);
  const checked = await (await toggleStep(revision,'Results',true)).json();
  assert.equal(checked.statuses[0].percent,60);
  assert.deepEqual(checked.config.plans[0].stepEdits,[{section:'Results',done:true}]);
  assert.ok(!checked.statuses[0].automaticParts.includes('Results'));
  assert.ok((await display()).commands.some(c=>c[0]===1 && c[5]==='60%'));
  assert.equal((await toggleStep(revision,'Results',false)).status,409);
  const reverted = await (await toggleStep(checked.config.revision,'Results',false)).json();
  assert.equal(reverted.statuses[0].percent,40);
  assert.equal(reverted.config.plans[0].stepEdits,undefined);
  const corrected = await (await toggleStep(reverted.config.revision,'Method',false)).json();
  assert.equal(corrected.statuses[0].percent,20);
  const recovered = await (await toggleStep(corrected.config.revision,'Method',true)).json();
  assert.equal(recovered.statuses[0].percent,40);
  revision = recovered.config.revision;
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
  assert.equal((await write(endpoint,'PUT',{taskId:'paper',action:'unpin',revision})).status,200);
  assert.deepEqual(await display(), initial);
  const config = (await (await fetch(endpoint)).json()).config;
  const sections = Array.from({ length: 24 }, (_, i) => '文'.repeat(60) + i);
  assert.ok(Buffer.byteLength(JSON.stringify(sections)) > 4096);
  assert.equal((await write(endpoint, 'PUT', { ...plan, sections, revision: config.revision })).status, 200);
});

test('replays paper-window visits for a matching reading task without inventing completion or time spent', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-paper-visits-'));
  const dataPath = path.join(dir, 'tasks.json');
  const reading = { id:'papers', title:'读论文，整理出一个脉络，思维导图，ppt', status:'todo', due_at:null };
  const saveTasks = tasks => writeFile(dataPath, JSON.stringify({date:'2026-11-13', timezone:'Asia/Shanghai', tasks}));
  await saveTasks([reading]);
  const paper = 'Revisiting How People Resume Interrupted Tasks';
  const capture = (when, title) => ({
    id:randomUUID(), source:'automatic', taskId:null, appName:'Google Chrome', detailSource:'window-title',
    capturedAt:when, pageTitle:title + ' | alphaXiv', summary:'窗口标题', nextStep:'', progress:null,
  });
  const evidence = JSON.stringify({version:1, records:[
    capture('2026-11-16T15:59:00.000Z', paper), // Yesterday in Shanghai.
    capture('2026-11-16T16:01:00.000Z', paper), // Today in Shanghai.
    capture('2026-11-17T02:43:05.000Z', paper),
    capture('2026-11-17T02:43:55.000Z', paper),
    capture('2026-11-17T02:44:00.000Z', '搜索'),
    capture('2026-11-17T02:44:10.000Z', 'Author Profile'),
    capture('2026-11-17T03:00:00.000Z', 'Search results for a paper on activity'),
    capture('2026-11-17T09:00:00.000Z', paper), // Future record relative to the Hub clock.
  ]});
  const history = dataPath + '.checkpoints.json';
  await writeFile(history, evidence);
  const server = createDemoServer({dataPath, distPath:dir, now:()=>Date.parse('2026-11-17T06:00:00Z')});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/v1/project-progress';
  const statuses = async () => {
    const result = await fetch(endpoint);
    assert.equal(result.status,200);
    return (await result.json()).statuses;
  };
  const [status] = await statuses();
  assert.deepEqual(status.paperVisits, {date:'2026-11-17',count:3,documents:1,minutes:[1,643],
    recent:[{title:paper,at:'2026-11-17T02:43:55.000Z'}]});
  assert.equal(status.percent,null);
  assert.equal(status.readingPosition,undefined);
  assert.deepEqual(status.completed,[]);
  // Ambiguous generic matches have no owner. A named match takes priority.
  const other = {...reading,id:'other',title:'Read academic papers'};
  await saveTasks([reading,other]);
  assert.ok((await statuses()).every(item=>!item.paperVisits));
  await saveTasks([reading,{...other,title:'Read Interrupted Tasks'}]);
  const [generic,named] = await statuses();
  assert.equal(generic.paperVisits,undefined);
  assert.deepEqual(named.paperVisits,status.paperVisits);
  assert.equal(await readFile(history,'utf8'),evidence);
});
