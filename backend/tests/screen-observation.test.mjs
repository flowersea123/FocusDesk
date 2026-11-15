import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
