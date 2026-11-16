import type { AiSession } from './focus-review.ts';

interface ActivityWindow { from:number; to:number }
export interface ConversationTurn extends ActivityWindow {
  id:string; state:AiSession['state']; userExcerpt?:string; assistantExcerpt?:string;
}
export interface AiConversation extends ActivityWindow {
  key:string; appName:string; title:string; linked:boolean; turns:ConversationTurn[]; windows:ActivityWindow[];
  activeSeconds:number; state:AiSession['state'];
}

function mergeWindows(windows: ActivityWindow[]) {
  const result: ActivityWindow[] = [];
  for (const window of windows.sort((a,b) => a.from - b.from || a.to - b.to)) {
    const previous = result.at(-1);
    if (previous && window.from <= previous.to) previous.to = Math.max(previous.to,window.to);
    else result.push({...window});
  }
  return result;
}

function lastState<T extends {to:number; state:AiSession['state']}>(spans: T[]): AiSession['state'] {
  if (spans.some(s => s.state === 'running')) return 'running';
  return spans.reduce((a,b) => a.to > b.to ? a : b).state;
}

/** Use source identities for related work. Unknown old runs share a labelled collection, never an inferred conversation. */
export function groupAiConversations(sessions: readonly AiSession[]): AiConversation[] {
  type Timed = AiSession & { start:number; end:number };
  const groups = new Map<string,Timed[]>();
  // A new web chat can receive its canonical URL after its first activity was recorded.
  const assigned = new Map<string, string>();
  const turnIds = new Map<string, string>();
  for (const s of sessions) {
    const runKey = s.appName + ':' + s.runId;
    if (s.conversationId && (!assigned.has(runKey) || !s.conversationId.startsWith('chatgpt-local-'))) assigned.set(runKey,s.conversationId);
    if (s.conversationTurnId) turnIds.set(runKey,s.conversationTurnId);
  }
  for (const session of sessions) {
    const start = Date.parse(session.from), end = Date.parse(session.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const runKey = session.appName + ':' + session.runId;
    const conversationId = assigned.get(runKey);
    const legacyLabel = /^(?:轮次 [a-f0-9]{6}|网页生成 [a-f0-9]{4}|网页对话)$/i.test(session.title);
    const identity = conversationId ? 'chat:' + conversationId : legacyLabel ? 'unlinked' : 'run:' + session.runId;
    const key = session.appName + ':' + identity;
    const bucket = groups.get(key) ?? [];
    bucket.push({...session,conversationId,conversationTurnId:turnIds.get(runKey),start,end});
    groups.set(key,bucket);
  }
  const conversations: AiConversation[] = [];
  for (const [key,spans] of groups) {
    spans.sort((a,b) => a.end - b.end || a.start - b.start);
    const byTurn = new Map<string,Timed[]>();
    for (const s of spans) {
      const id = s.conversationTurnId || s.runId;
      const bucket = byTurn.get(id) ?? [];
      bucket.push(s); byTurn.set(id,bucket);
    }
    const turns: ConversationTurn[] = [];
    for (const [id,parts] of byTurn) {
      const newest = [...parts].reverse();
      turns.push({
      id, from:Math.min(...parts.map(p => p.start)), to:parts.at(-1)!.end,
      state:lastState(parts.map(p => ({to:p.end,state:p.state}))),
      userExcerpt:newest.find(p => p.userExcerpt)?.userExcerpt,
      assistantExcerpt:newest.find(p => p.assistantExcerpt)?.assistantExcerpt,
      });
    }
    turns.sort((a,b) => a.from - b.from || a.to - b.to);
    const windows = mergeWindows(spans.map(s => ({from:s.start,to:s.end})));
    const linked = Boolean(spans[0].conversationId);
    const title = [...spans].reverse().find(s => s.conversationTitle)?.conversationTitle ||
      (linked ? turns.find(t => t.userExcerpt)?.userExcerpt?.slice(0,72) || '未命名对话' :
        key.endsWith(':unlinked') ? '未关联到对话的旧活动' : spans[0].title);
    conversations.push({key, linked, title, appName:spans[0].appName, turns, windows, from:windows[0].from,
      to:windows.at(-1)!.to, activeSeconds:windows.reduce((sum,w) => sum + (w.to - w.from) / 1000,0), state:lastState(turns)});
  }
  return conversations;
}
