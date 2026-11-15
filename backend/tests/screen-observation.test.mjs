import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpointStore } from '../src/checkpoint-store.ts';
import { once } from 'node:events';
import { createScreenObservationHandler } from '../src/screen-observation.ts';

// A two-pixel square re-encoded by the browser's JPEG encoder.
const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ+AD//Z';
const output = { summary: '正在核对报告。', nextStep: '继续讨论部分。', taskLabel: 'Lab Report',
  evidence: 'Progress: 3/4 sections completed', completedParts: [] };
function completion(result = output) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
}
async function setup(t, options = {}) {
  const server = createServer(createScreenObservationHandler({ getTasks: async () => [{id:'a', title:'Lab Report'}],
    fetcher: async () => completion(), ...options }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const url = base + '/api/v1/screen-observation';
  return { url, post: (data = {image, taskId:'a'}, headers = {}) => fetch(url, {method: 'POST',
    headers:{'Content-Type':'application/json',Origin:base,...headers}, body:JSON.stringify(data)}) };
}

test('returns task-bound evidence and checked named rows only; pictures and task titles do not enter the result/prompt text', async t => {
  const { post } = await setup(t, { fetcher: async (url, options) => {
    assert.equal(url,'http://127.0.0.1:18187/v1/chat/completions'); assert.equal(options.redirect,'error');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model,'focusdesk-mail');
    assert.equal(payload.messages[1].content[1].image_url.url,image);
    assert.ok(!payload.messages[1].content[0].text.includes('Lab Report'));
    return completion({...output,completedParts:[
      {name:'Introduction',line:'✓ Introduction'}, {name:'Method',line:'Method — completed'},
      {name:'Method',line:'✓ Method'}, {name:'Results',line:'☐ Results'}, {name:'Notes',line:'Read Notes'},
      {name:'Review',line:'Review — not completed'}, {name:'Debrief',line:'✓ unrelated row'}, {name:'10',line:'10'},
    ]});
  }});
  const res=await post(); assert.equal(res.status,200); assert.equal(res.headers.get('cache-control'),'no-store');
  assert.deepEqual(await res.json(),{summary:output.summary,nextStep:output.nextStep,completedParts:['Introduction','Method'],
    progress:{percent:75,evidence:output.evidence}});
});

test('keeps explicit parts without a denominator, rejects unbound or conflicting progress and unrelated percentages', async t => {
  let result = output;
  const {post}=await setup(t,{fetcher: async()=>completion(result)});
  for (const [taskId, label, evidence, expected] of [
    [null,'Lab Report','Progress: 1/4',null], ['a','A different report','Progress: 3/4',null],
    ['a','Lab Report','Battery: 50%',null], ['a','Lab Report','Page 3/4',null],
    ['a','Lab Report','Progress 6/5',null], ['a','Lab Report','Progress 1/0',null],
    ['a','Lab Report','Progress 3/4 completed (80%)',null], ['a','Lab Report','Progress unknown',null],
    ['a','Lab Report','Progress: 2/3 completed',67], ['a','LAB report','进度 80%',80],
  ]) {
    result={...output,taskLabel:label,evidence,completedParts:[{name:'Introduction',line:'[x] Introduction'}]};
    const data=await (await post({image,taskId})).json();
    assert.equal(data.progress?.percent ?? null,expected); assert.deepEqual(data.completedParts,['Introduction']);
  }
});

test('rejects invalid/oversized image bytes, unknown tasks, nonlocal origins and method before inference', async t => {
  const {url,post}=await setup(t,{fetcher: async()=>assert.fail('invalid image or request reached inference')});
  assert.equal((await fetch(url)).status,405);
  assert.equal((await post(undefined,{Origin:'https://example.org'})).status,403);
  assert.equal((await post(undefined,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post({image,taskId:'gone'})).status,409);
  for (const invalid of ['data:image/png;base64,aaaa',image.slice(0,-4),image+'!']) {
    assert.equal((await post({image:invalid,taskId:null})).status,400);
  }
  const corrupt=Buffer.from(image.split(',')[1],'base64');
  const sof=corrupt.indexOf(Buffer.from([0xff,0xc0])); corrupt.writeUInt16BE(16000,sof+5);
  assert.equal((await post({image:'data:image/jpeg;base64,'+corrupt.toString('base64'),taskId:null})).status,400);
  const oversized = await post({image:'a'.repeat(1_405_000),taskId:null});
  assert.equal(oversized.status,413);
  assert.equal((await oversized.json()).error.code,'IMAGE_TOO_LARGE');
  async function* chunks() {
    for (let i = 0; i < 24; i++) yield Buffer.alloc(64 * 1024, 97);
  }
  const chunked = await fetch(url, {method:'POST', headers:{Origin:new URL(url).origin,'Content-Type':'application/json'},
    body:chunks(), duplex:'half'});
  assert.equal(chunked.status,413);
  assert.equal((await chunked.json()).error.code,'IMAGE_TOO_LARGE');
});

test('limits CPU inference to one active request and releases the slot after errors and timeout', async t => {
  let finish, started, block = true;
  const entered = new Promise(resolve => { started=resolve; });
  const {post}=await setup(t,{timeoutMs:500,fetcher: async (_url,{signal})=>{
    if (!block) return completion();
    started(); return new Promise((resolve,reject)=>{
      finish=()=>resolve(new Response('fail',{status:500})); signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
  }});
  const first=post(); await entered;
  assert.equal((await post()).status,429);
  finish(); assert.equal((await first).status,503);
  assert.equal((await post()).status,504);
  block=false; assert.equal((await post()).status,200);
});

test('refuses remote model hosts and incomplete model output', async t => {
  const remote=await setup(t,{endpoint:'http://example.org',fetcher:async()=>assert.fail('remote model contacted')});
  assert.equal((await remote.post()).status,503);
  const incomplete=await setup(t,{fetcher:async()=>Response.json({ choices:[{finish_reason:'length'}] })});
  assert.equal((await incomplete.post()).status,502);
});

test('automatic capture attributes completion only to a visible, matching task title', async t => {
  let taskLabel = 'Another report';
  const {post} = await setup(t, {fetcher: async () => completion({...output, taskLabel,
    completedParts:[{name:'Method',line:'✓ Method'}]})});
  const automatic = () => post({image, taskId:'a', automatic:true}).then(r => r.json());
  let seen = await automatic();
  assert.deepEqual(seen.completedParts, []);
  assert.equal(seen.progress, null);
  assert.equal(seen.summary, output.summary);
  taskLabel = ' LAB   REPORT ';
  seen = await automatic();
  assert.deepEqual(seen.completedParts, ['Method']);
  assert.equal(seen.progress.percent, 75);
  assert.equal((await post({image, taskId:null, automatic:true})).status, 400);
});

test('binds a bookmark to document prose, excludes outlines and ambiguities, and never infers reading completion', async t => {
  const candidate = { ...output, readingPage:'body', sectionHeading:'2. Method',
    bodyQuote:'Participants reviewed one article before returning to the experimental task.',
    completedParts:[{name:'Method',line:'Method completed'}] };
  let response = candidate;
  const {post} = await setup(t, {fetcher:async () => completion(response)});
  const observe = async (taskId = 'a', automatic = true) => (await post({image,taskId,automatic})).json();
  const section = await observe();
  assert.equal(section.readingSection, 'Method');
  assert.equal(section.readingDocument, 'Lab Report');
  assert.deepEqual(section.completedParts, []);
  assert.equal(section.progress, null);
  for (const change of [{readingPage:'contents'}, {readingPage:'other'}, {bodyQuote:''},
    {bodyQuote:'Introduction .... 4'}, {sectionHeading:'A Very Long Heading',bodyQuote:'A Very Long Heading'},
    {taskLabel:'An Example Very Long Document Title',bodyQuote:'An Example Very Long Document Title'}, {sectionHeading:'Contents'}, {sectionHeading:'Lab Report'}, {taskLabel:'Different Paper'}]) {
    response = {...candidate, ...change};
    const found = await observe();
    assert.equal(found.readingSection, undefined, JSON.stringify(change));
    assert.equal(found.readingDocument, undefined);
    if (change.readingPage === 'contents') assert.equal(found.summary,'正在查看《Lab Report》的目录。');
  }
  response = {...candidate, taskLabel:'Different Paper'};
  assert.equal((await observe('a',false)).readingDocument, 'Different Paper');
  assert.equal((await observe(null,false)).readingSection, undefined);
});

test('automatic reading under a short task label requires an existing manually reviewed document for that same task', async t => {
  const dir = await mkdtemp(join(tmpdir(),'focusdesk-reviewed-paper-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const store = createCheckpointStore(join(dir,'tasks.json'));
  const title = 'A Long Paper Title About Returning to a Task After an Interruption';
  const sample = {readingPage:'body',sectionHeading:'Method',
    bodyQuote:'Participants read the long article before working on a secondary task.'};
  let visibleTitle = title;
  const {post} = await setup(t,{getTasks:async () => [{id:'a',title:'Read paper'},{id:'b',title:'Another task'}],
    getKnownDocuments:store.reviewedDocuments,fetcher:async () => completion({...output,...sample,taskLabel:visibleTitle})});
  const observed = async (taskId='a',automatic=true) => (await post({taskId,image,automatic})).json();
  const record = taskId => ({taskId,id:randomUUID(),capturedAt:new Date().toISOString(),source:'manual',
    readingSection:'Introduction',readingDocument:title,summary:'正在阅读。',nextStep:'',completedParts:[],progress:null});
  assert.equal((await observed()).readingSection,undefined);
  assert.equal((await observed('a',false)).readingDocument,title);
  const automatic = {...record('a'),source:'automatic'};
  await store.add(automatic);
  await store.confirmReading(automatic.id,'Introduction');
  await store.add(record('b'));
  assert.equal((await observed()).readingSection,undefined);
  const first = record('a'),second = record('a');
  await store.add(first);
  await store.add(second);
  visibleTitle = '  '+ title.replace('Long','LONG  ')+'  ';
  assert.equal((await observed()).readingSection,'Method');
  visibleTitle = title+' Appendix';
  assert.equal((await observed()).readingSection,undefined);
  visibleTitle = title;
  await store.remove(first.id);
  assert.equal((await observed()).readingSection,'Method');
  await store.remove(second.id);
  assert.equal((await observed()).readingSection,undefined);
  assert.equal((await observed('b')).readingSection,'Method');
});

test('rereads unlabeled status marks once for an evidenced percentage; unmarked, empty or conflicting rows do not count', async t => {
  const candidates = ['Input','Draft','Edited'].map(name=>({name,line:name}));
  let variant = output;
  let marks = [{name:'Input',mark:'[x]'}, {name:'Draft',mark:'[ ]'}, {name:'Edited',mark:''}, {name:'Other',mark:'[x]'}];
  let rereads = 0;
  const {post} = await setup(t,{fetcher: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.response_format.json_schema.name === 'observation') return completion({...variant, completedParts:candidates});
    rereads++;
    assert.ok(!body.messages[1].content[0].text.includes('Edited'));
    return marks ? completion({rows:marks}) : new Response('',{status:503});
  }});
  const inspect=async()=>(await post()).json();
  variant={...output,summary:'Input, Draft and Edited are done.',nextStep:'Submit all three.'};
  const partial = await inspect();
  assert.deepEqual(partial.completedParts,['Input']);
  assert.match(partial.summary,/75%.*Input/);assert.doesNotMatch(partial.summary,/Draft|Edited/);assert.equal(partial.nextStep,'');
  marks.push({name:'Input',mark:''});
  assert.deepEqual((await inspect()).completedParts,[]);
  marks = null;
  const unavailable = await inspect();assert.deepEqual(unavailable.completedParts,[]);assert.equal(unavailable.progress.percent,75);
  assert.equal(unavailable.summary,'《Lab Report》显示整体进度为 75%。');assert.equal(unavailable.nextStep,'');
  variant={...output,readingPage:'contents'}; assert.deepEqual((await inspect()).completedParts,[]);
  variant={...output,taskLabel:'Other'}; assert.deepEqual((await inspect()).completedParts,[]);
  assert.equal(rereads,3);
});
