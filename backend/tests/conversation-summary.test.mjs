import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { groupAiConversations } from '../../contracts/ai-conversations.ts';
import { createConversationSummaries } from '../src/conversation-summary.ts';

const base = Date.parse('2026-11-16T00:00:00Z');
function row(runId, start, end, overrides = {}) {
  return {runId, appName:'Codex', title:'轮次 c0eb5d', conversationId:'c1', conversationTurnId:'t1',
    from:new Date(base+start).toISOString(), to:new Date(base+end).toISOString(), state:'finished', ...overrides};
}
test('groups observed work by conversation and root turn, merges overlaps, and preserves idle gaps', () => {
  const chats = groupAiConversations([row('parent',0,5000,{userExcerpt:'看图'}),row('worker',1000,8000,{assistantExcerpt:'修复时间条'}),
    row('worker',12000,15000,{conversationTurnId:'t1'}),row('next',21000,25000,{conversationTurnId:'t2',userExcerpt:'再核对'}),
    row('second',1000,6000,{conversationId:'c2'}),row('old',0,3000,{conversationId:undefined}),row('unknown',5000,7000,{conversationId:undefined})]);
  assert.equal(chats.length,3);
  const c=chats.find(c=>c.key==='Codex:chat:c1');
  assert.equal(c.turns.length,2); assert.equal(c.activeSeconds,15);
  assert.equal(c.to-c.from,25000); assert.equal(c.windows.length,3);
  assert.equal(c.turns[0].userExcerpt,'看图');assert.equal(c.turns[0].assistantExcerpt,'修复时间条');
  assert.equal(chats.find(c=>!c.linked).title,'未关联到对话的旧活动');
});

test('uses the assigned web conversation and turn even when a preliminary segment had temporary ids', () => {
  const provisional = row('web1',0,100,{appName:'ChatGPT',conversationId:'chatgpt-local-temp',conversationTurnId:undefined});
  const canonical = row('web1',40000,43000,{appName:'ChatGPT',conversationId:'chatgpt-real',conversationTurnId:'message-1'});
  const otherTab = {...canonical,runId:'web2'};
  const chats=groupAiConversations([provisional,otherTab,canonical]);
  assert.equal(chats.length,1);assert.equal(chats[0].turns.length,1);assert.equal(chats[0].activeSeconds,3.1);
});

test('source changes regenerate one local summary, heartbeat changes reuse it, and unavailable sources retain excerpts',async () => {
  let requests = 0;
  const summary = createConversationSummaries({endpoint:'http://127.0.0.1:18187',fetcher:async (url,options)=>{
    requests++; assert.equal(url.hostname,'127.0.0.1');
    const input=JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(input[0].user,'读到第几页？'); assert.equal(input[0].assistant,'第十二页');
    return Response.json({choices:[{message:{content:JSON.stringify({summary:'讨论阅读进度，答复为第十二页。'})}}]});
  }});
  const sessions = [row('p',0,1000,{userExcerpt:'读到第几页？',assistantExcerpt:'第十二页'})];
  const chats=groupAiConversations(sessions);
  assert.deepEqual(summary(chats),{}); assert.deepEqual(summary(chats),{});
  await delay(5);
  assert.equal(summary(groupAiConversations([{...sessions[0],to:new Date(base+4000).toISOString()}]))[chats[0].key],'讨论阅读进度，答复为第十二页。');
  assert.equal(requests,1);
  const noSource = groupAiConversations([row('p',0,500)]);assert.deepEqual(summary(noSource),{});assert.equal(requests,1);
  let remoteCalls=0;
  const remote=createConversationSummaries({endpoint:'https://example.org',fetcher:()=>{remoteCalls++;throw Error();}});
  assert.deepEqual(remote(chats),{});await delay(1);assert.equal(remoteCalls,0);
});
