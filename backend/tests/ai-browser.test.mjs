import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAiActivitySources, BROWSER_ACTIVITY_ORIGIN } from '../src/ai-activity-sources.ts';

test('the browser adapter admits the packaged extension, keeps simultaneous runs distinct and closes its recording gate', async t => {
  const manifest = JSON.parse(await readFile(new URL('../../extensions/chatgpt-activity/manifest.json',import.meta.url),'utf8'));
  const hex = createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32);
  assert.equal(BROWSER_ACTIVITY_ORIGIN,'chrome-extension://' + [...hex].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join(''));
  let at = 1000;
  const source = createAiActivitySources({now:()=>at,codex:()=>({poll:async()=>[]})});
  const server = createServer(source.handle);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(r=>server.close(r));});
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (body, origin=BROWSER_ACTIVITY_ORIGIN) => fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  assert.equal((await post({action:'status'},'https://chatgpt.com')).status,403);
  assert.deepEqual(await (await post({action:'status'})).json(),{session:null});
  const control = new AbortController(), monitor = source.open(control.signal);
  const {session} = await (await post({action:'status'})).json(); assert.ok(session);
  const first=randomUUID(),second=randomUUID();
  for (const id of [first,second]) assert.equal((await post({action:'running',session,id})).status,200);
  const reading = () => monitor.poll(control.signal);
  const observed = await reading();
  assert.equal(new Set(observed.map(e=>e.runId)).size,2);
  assert.ok(observed.every(e=>e.appName==='ChatGPT' && e.at===1000));
  at+=2000;
  await post({action:'finished',id:first,session});
  assert.deepEqual((await reading()).map(e=>[e.runId,e.state,e.at]),[
    ['chatgpt-'+first,'finished',3000], ['chatgpt-'+second,'running',1000]]);
  at+=40_000;
  assert.deepEqual((await reading()).map(e=>[e.state,e.at]),[['interrupted',1000]]);
  assert.equal((await post({action:'running',id:first,session,content:'extra'})).status,400);
  control.abort(); assert.equal((await post({action:'running',id:first,session})).status,409);
  await monitor.close();
  const next = source.open(new AbortController().signal);
  assert.notEqual((await (await post({action:'status'})).json()).session,session);
  assert.deepEqual(await next.poll(new AbortController().signal),[]); await next.close();
});

test('new web metadata joins repeated turns, promotes temporary chats, retains earlier fields and rejects invalid excerpts', async t => {
  const sources = createAiActivitySources({codex:() => ({poll:async() => []})});
  const server = createServer(sources.handle);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const epoch = new AbortController(), source = sources.open(epoch.signal);
  const post = body => fetch('http://127.0.0.1:' + server.address().port, {method:'POST',
    headers:{'Content-Type':'application/json', Origin:BROWSER_ACTIVITY_ORIGIN},body:JSON.stringify(body)});
  const {session} = await (await post({action:'status'})).json();
  const conversationId = 'chatgpt-' + '9a'.repeat(12), localId = 'chatgpt-local-' + randomUUID(), first = randomUUID();
  assert.equal((await post({action:'running', session, id:first, conversationId:localId, userExcerpt:'How do the two designs compare?'})).status,200);
  assert.equal((await post({action:'running', session, id:first, conversationId, conversationTitle:'Design comparison'})).status,200);
  assert.equal((await post({action:'finished', session, id:first, conversationId, assistantExcerpt:'The second design uses less space.'})).status,200);
  const second = randomUUID(), conversationTurnId = 'chatgpt-msg-' + 'f1'.repeat(12);
  assert.equal((await post({action:'running', session, id:second, conversationId, conversationTurnId})).status,200);
  const events = await source.poll(epoch.signal);
  const completed = events.find(row => row.state === 'finished');
  assert.equal(completed.conversationId,conversationId);
  assert.equal(completed.conversationTitle,'Design comparison');
  assert.equal(completed.userExcerpt,'How do the two designs compare?');
  assert.equal(completed.assistantExcerpt,'The second design uses less space.');
  assert.equal(events.at(-1).conversationId,conversationId);
  assert.equal(events.at(-1).conversationTurnId,conversationTurnId);
  for (const bad of [{conversationId:'https://chatgpt.com/c/raw-id'}, {assistantExcerpt:'unbound'},
    {conversationId, userExcerpt:'x'.repeat(321)}, {conversationId, assistantExcerpt:'a\nb'}, {conversationId, conversationTitle:'x'.repeat(101)},
    {conversationId, fullConversation:'extra'}, {conversationId, conversationTurnId:'raw-message-id'}]) {
    assert.equal((await post({id:second,session,action:'running',...bad})).status,400);
  }
  await source.close();
});
