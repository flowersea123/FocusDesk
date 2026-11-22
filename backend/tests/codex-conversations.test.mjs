import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { codexRunId, resolveCodexConversations } from '../src/codex-conversations.ts';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'codex-conversation-'));
  const databasePath = join(dir,'history.sqlite'), statePath = join(dir,'state_5.sqlite');
  const db = new DatabaseSync(databasePath), state = new DatabaseSync(statePath);
  t.after(async () => { db.close(); state.close(); await rm(dir,{recursive:true,force:true}); });
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,root_turn_id TEXT,first_user_item_id TEXT,
    final_agent_item_id TEXT,started_at INTEGER,completed_at INTEGER,PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,
    PRIMARY KEY(thread_id,turn_id,item_id));`);
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT,title TEXT,name TEXT); CREATE TABLE thread_spawn_edges(child_thread_id TEXT PRIMARY KEY,parent_thread_id TEXT);');
  return {db,state,databasePath,
    thread(id,source,name) {state.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(id,source,name || '',name || '');},
    turn(thread,turn,root,first=null,last=null) {db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,1000,1200)').run(thread,turn,root,first,last);},
    item(thread,turn,id,type,object) {db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run(thread,turn,id,type,JSON.stringify(object));},
    event(thread_id,turn_id) { return {appName:'Codex',runId:codexRunId({thread_id,turn_id}),title:'轮次',at:1100_000}; },
    resolve(rows) {return resolveCodexConversations(rows,{databasePath,statePath});},
  };
}
const ask = text => ({type:'userMessage',content:[{type:'image',imageUrl:'data:image/jpeg;base64,IMAGE_MUST_NOT_LEAK'},{type:'text',text}]});
const answer = (text,phase='final_answer') => ({type:'agentMessage',text,phase});

test('old main, guardian and nested worker hashes resolve to the same primary user turn with only its public text',async t => {
  const f = await fixture(t);
  f.thread('main','vscode','核对论文数据'); f.thread('worker','{"subagent":{"thread_spawn":{"parent_thread_id":"main"}}}','PRIVATE WORKER TITLE');
  f.thread('auto','{"subagent":{"other":"guardian"}}','PRIVATE GUARDIAN TITLE');
  f.turn('main','u1','u1','user',null); f.turn('main','u2','u2','user2',null);
  f.turn('worker','w1','u1','childUser','childReply'); f.turn('auto','g1','w1','autoUser','autoReply');
  f.item('main','u1','user','userMessage',ask('# Files mentioned by the user:\n' + 'x'.repeat(2600) + '\n## My request:\n请核对表 2 的单位。'));
  f.item('main','u2','user2','userMessage',ask('补充图注。'));
  f.item('worker','w1','childUser','userMessage',ask('PRIVATE WORKER TASK'));
  f.item('auto','g1','autoReply','agentMessage',answer('PRIVATE GUARDIAN RESPONSE'));
  const requests=[f.event('auto','g1'),f.event('main','u1'),f.event('worker','w1'),f.event('main','u2')];
  let result=await f.resolve(requests);
  assert.equal(new Set(result.map(r=>r.conversationId)).size,1);
  assert.equal(new Set(result.map(r=>r.conversationTurnId)).size,2);
  assert.notEqual(result[0].conversationTurnId,result[0].runId);
  assert.equal(result[0].conversationTurnId,result[1].runId);
  assert.equal(result[0].conversationTitle,'核对论文数据');
  assert.equal(result[0].userExcerpt,'请核对表 2 的单位。');
  assert.equal(result[0].assistantExcerpt,undefined);
  f.db.prepare('UPDATE thread_turns SET final_agent_item_id=? WHERE turn_id=?').run('final','u1');
  f.item('main','u1','final','agentMessage',answer('表 2 已统一为毫秒。\n<oai-mem-citation>PRIVATE MEMORY</oai-mem-citation>'));
  result=await f.resolve(requests);
  assert.ok(result.slice(0,3).every(r=>r.assistantExcerpt==='表 2 已统一为毫秒。'));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|MUST_NOT_LEAK|Files mentioned/);
});

test('identical titles stay separate, fork ambiguity and unresolved internal rounds do not disclose other chats', async t=>{
  const f=await fixture(t);
  for(const main of ['left','right']) {
    f.thread(main,'cli','写报告');f.turn(main,'same','same','u','a');
    f.item(main,'same','u','userMessage',ask('问题'));f.item(main,'same','a','agentMessage',answer('结果'));
  }
  f.thread('guard','{"subagent":{"other":"guardian"}}','INTERNAL');
  f.turn('guard','vend','same','u','a');
  f.turn('missing-owner','orphan','same','u','a');
  f.thread('worker','{"subagent":{"thread_spawn":{"parent_thread_id":"left"}}}','INTERNAL');
  f.turn('worker','child','same','u','a');
  const result=await f.resolve([f.event('left','same'),f.event('right','same'),f.event('guard','vend'),f.event('worker','child'),f.event('missing-owner','orphan')]);
  assert.notEqual(result[0].conversationId,result[1].conversationId);
  assert.equal(result[2].conversationId,undefined);assert.equal(result[2].assistantExcerpt,undefined);
  assert.equal(result[4].conversationId,undefined);
  assert.equal(result[3].conversationId,result[0].conversationId);assert.equal(result[3].conversationTurnId,result[0].conversationTurnId);
});

test('ignores nonfinal text, tool bodies and wrapper-only user records; excerpts are bounded', async t=>{
  const f=await fixture(t);f.thread('t','vscode','课题');
  for(const id of ['tool','draft','long','wrapper','bad'])f.turn('t',id,id,'u','a');
  f.item('t','tool','a','commandExecution',{type:'agentMessage',phase:'final_answer',text:'PRIVATE'});
  f.item('t','draft','a','agentMessage',answer('PRIVATE','commentary'));
  f.item('t','long','u','userMessage',ask('数'.repeat(290)+'🙂'.repeat(40)));
  f.item('t','wrapper','u','userMessage',ask('<environment_context>PRIVATE</environment_context>'));
  f.item('t','bad','a','agentMessage',{type:'reasoning',text:'PRIVATE'});
  const result=await f.resolve(['tool','draft','long','wrapper','bad'].map(id=>f.event('t',id)));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|\uFFFD|MUST_NOT_LEAK/);
  assert.ok(result[2].userExcerpt.length<=320 && result[2].userExcerpt.endsWith('…'));
  assert.equal(result[3].userExcerpt,undefined);
});

test('older-than-index journal references resolve by their recorded time; missing stores leave a review usable', async t=>{
  const f=await fixture(t);f.thread('old','vscode','先前对话');f.turn('old','original','original');
  f.db.exec(`WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<16390)
    INSERT INTO thread_turns SELECT 'recent',cast(x AS TEXT),NULL,NULL,NULL,9000,10000 FROM seq`);
  const event=f.event('old','original'), unrelated={appName:'ChatGPT',runId:'browser',title:'网页'};
  const rows=await f.resolve([event,unrelated]); assert.equal(rows[0].conversationTitle,'先前对话');assert.equal(rows[1],unrelated);
  const missing = [event];
  assert.deepEqual(await resolveCodexConversations(missing,{databasePath:f.databasePath+'.missing'}),missing);
});

test('an established index recovers both evicted identities and the unseen prefix of an oversized append', async t => {
  const f = await fixture(t);
  f.thread('main','vscode','主对话'); f.turn('main','first','first');
  const first = f.event('main','first');
  const [before] = await f.resolve([first]);
  assert.equal(before.conversationTitle,'主对话');
  f.turn('main','skipped','skipped');
  f.db.exec(`WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<16400)
    INSERT INTO thread_turns SELECT 'busy',cast(x AS TEXT),NULL,NULL,NULL,9000,10000 FROM seq`);
  const [evicted,skipped] = await f.resolve([first,f.event('main','skipped')]);
  assert.equal(evicted.conversationId,before.conversationId);
  assert.equal(skipped.conversationTitle,'主对话');
  assert.notEqual(skipped.conversationTurnId,evicted.conversationTurnId);
});
