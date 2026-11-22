import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

type Identity = { thread_id:string; turn_id:string };
type Turn = Identity & {root_turn_id:string | null; first_user_item_id:string | null; final_agent_item_id:string | null};
type Thread = {source:string; title:string; name:string};
type Metadata = {conversationId:string; conversationTurnId?:string; conversationTitle?:string; userExcerpt?:string; assistantExcerpt?:string};
type Options = {databasePath?:string; statePath?:string};
type Row = {appName:string; runId:string; from?:string | number; to?:string | number; at?:number};
export const defaultCodexHistory = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'thread_history_1.sqlite');

export function codexRunId({thread_id,turn_id}: Identity) {
  return 'codex-' + createHash('sha256').update(thread_id).update('\0').update(turn_id).digest('hex').slice(0,24);
}
function chatId(id: string) {
  return 'codex-chat-' + createHash('sha256').update(id).digest('hex').slice(0,24);
}

// The older journal has irreversible run hashes. Index recent turn identities, never item bodies.
// Cache is bounded independently of full history size and invalidates on replacement.
const indexLimit = 16_384;
type Index = {key:string; cursor:number; floor:number; runs:Map<string,Identity & {cursor:number}>; older:Map<string,Identity | null>};
const indexes = new Map<string,Index>();
function readIndex(db: DatabaseSync, path: string, key: string, wanted: Set<string>, windows: number[]) {
  let index = indexes.get(path);
  if (!index || index.key !== key) {
    index = {key, cursor:0, floor:0, runs:new Map(), older:new Map()};
    if (!indexes.has(path) && indexes.size >= 4) indexes.delete(indexes.keys().next().value!);
    indexes.set(path,index);
  }
  const rows = db.prepare('SELECT rowid AS cursor,thread_id,turn_id FROM thread_turns WHERE rowid>? ORDER BY rowid DESC LIMIT ?')
    .all(index.cursor,indexLimit);
  for (const r of rows.reverse()) {
    index.cursor = Math.max(index.cursor,Number(r.cursor));
    if (typeof r.thread_id !== 'string' || typeof r.turn_id !== 'string') continue;
    const id = {thread_id:r.thread_id,turn_id:r.turn_id};
    index.runs.set(codexRunId(id),{...id,cursor:index.cursor});
  }
  while (index.runs.size > indexLimit) index.runs.delete(index.runs.keys().next().value!);
  index.floor = index.runs.values().next().value?.cursor ?? 1;
  // Older installations can have well over 16K turns inside the 90-day journal. Restrict
  // the fallback to lifecycles overlapping this review's actual recording window.
  // The immutable identities are small; never search thread_items for this migration.
  const absent = new Set([...wanted].filter(id => !index.runs.has(id) && !index.older.has(id)));
  if (absent.size && index.floor > 1 && windows.length) {
    const begin = Math.floor(Math.min(...windows) / 1000) - 1, end = Math.ceil(Math.max(...windows) / 1000) + 1;
    const candidates = db.prepare('SELECT thread_id,turn_id FROM thread_turns WHERE rowid<? AND started_at<=? AND (completed_at IS NULL OR completed_at>=?)');
    for (const row of candidates.iterate(index.floor,end,begin)) {
      const id = {thread_id:row.thread_id as string, turn_id:row.turn_id as string};
      const hash = codexRunId(id);
      if (absent.delete(hash)) index.older.set(hash,id);
      if (!absent.size) break;
    }
    for (const id of absent) index.older.set(id,null);
    while (index.older.size > 4096) index.older.delete(index.older.keys().next().value!);
  }
  return (id: string) => index.runs.get(id) ?? index.older.get(id);
}

function optionalQuery(db: DatabaseSync | undefined, sql: string): StatementSync | undefined {
  try {return db?.prepare(sql);} catch {return undefined;}
}
function plainText(input: unknown, limit: number) {
  if (typeof input !== 'string') return '';
  let text = input.trim();
  const request = /(?:^|\n)## My request:\s*/.exec(text);
  if (request) text = text.slice(request.index + request[0].length);
  if (/^\s*(?:<(?:environment_context|permissions\w*|system\w*|developer\w*|subagent\w*|user_instructions|tool_\w*|INSTRUCTIONS|skills_\w*|turn_aborted|analysis|reasoning|image|audio)\b|# (?:Files mentioned by the user|AGENTS\.md)|Message Type:\s*(?:MESSAGE|NEW_TASK|FINAL_ANSWER))/i.test(text)) return '';
  text = text.split(/<oai-mem-citation>|<environment_context>|<subagent_notification>/i)[0]
    .replace(/!?\[[^\]]*\]\((?:data:|file:|\/Users\/|\/home\/|\/private\/|\/var\/)[^)]*\)/gi, '')
    .replace(/data:[^\s]*;base64,[A-Za-z0-9+/=]*/gi, '')
    .replace(/(?:\/private)?\/var\/folders\/\S+|\S*codex-clipboard-[\w-]+\.\w+/gi,'')
    .replace(/[A-Za-z0-9+/=]{100,}/g,'')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu,' ').trim();
  if (text.length > limit) text = text.slice(0,limit-1).trimEnd().replace(/[\uD800-\uDBFF]$/,'') + '…';
  return text;
}
function subagent(source: string): {internal:boolean; parent?:string} {
  try {
    const sub = JSON.parse(source).subagent;
    return {internal:!!sub, parent:typeof sub?.thread_spawn?.parent_thread_id === 'string' ? sub.thread_spawn.parent_thread_id : undefined};
  } catch {return {internal:/subagent|guardian/i.test(source)};}
}

function reader(db: DatabaseSync, state?: DatabaseSync) {
  const identity = 'thread_id,turn_id';
  const cols = new Set(db.prepare('PRAGMA table_info(thread_turns)').all().map(c => c.name));
  const fields = [identity,...['root_turn_id','first_user_item_id','final_agent_item_id'].map(k => cols.has(k) ? k : 'NULL AS ' + k)].join(',');
  const turn = db.prepare('SELECT ' + fields + ' FROM thread_turns WHERE thread_id=? AND turn_id=?');
  // Forked conversations can contain copies with the same turn id. An ambiguous root must not
  // silently attach someone's answer to another conversation.
  const rootQuery = db.prepare('SELECT ' + fields + ' FROM thread_turns WHERE turn_id=? LIMIT 2');
  const meta = optionalQuery(state,'SELECT substr(source,1,1200) AS source,substr(name,1,200) AS name,substr(title,1,1200) AS title FROM threads WHERE id=?')
    ?? optionalQuery(state,"SELECT substr(source,1,1200) AS source,'' AS name,substr(title,1,1200) AS title FROM threads WHERE id=?");
  const edge = optionalQuery(state,'SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id=?');
  // Only the two public messages explicitly designated by Codex for a real user turn
  // are eligible. Project text fields in SQLite: image blocks and tool/reasoning
  // payloads never enter JS, even if an item ID is malformed.
  const itemFilter = "thread_id=? AND turn_id=? AND item_id=? AND length(CAST(item_json AS BLOB))<=2097152 AND json_valid(item_json)";
  const ask = optionalQuery(db,`WITH item AS MATERIALIZED (SELECT item_json FROM thread_items WHERE ${itemFilter} AND item_type='userMessage')
    SELECT substr(json_extract(part.value,'$.text'),max(1,instr(json_extract(part.value,'$.text'),char(10)||'## My request:')),2400) AS text
    FROM item,json_each(item.item_json,'$.content') AS part
    WHERE json_extract(item_json,'$.type')='userMessage' AND part.type='object' AND json_extract(part.value,'$.type')='text'
      AND json_type(part.value,'$.text')='text' LIMIT 6`);
  const answer = optionalQuery(db,`SELECT substr(json_extract(item_json,'$.text'),1,2400) AS text FROM thread_items WHERE ${itemFilter}
    AND item_type='agentMessage' AND json_extract(item_json,'$.type')='agentMessage'
    AND coalesce(json_extract(item_json,'$.phase'),'final_answer')='final_answer'`);
  const threads = new Map<string,Thread | undefined>();
  const rootCache = new Map<string,Turn | undefined>();
  const summaries = new Map<string,Metadata>();
  function thread(id: string) {
    if (!threads.has(id)) threads.set(id,meta?.get(id) as Thread | undefined);
    return threads.get(id);
  }
  function findRoot(id: string) {
    if (!rootCache.has(id)) {
      const rows = rootQuery.all(id) as Turn[];
      rootCache.set(id, rows.length === 1 ? rows[0] : undefined);
    }
    return rootCache.get(id);
  }
  return (observed: Identity): Metadata | undefined => {
    let root = turn.get(observed.thread_id,observed.turn_id) as Turn | undefined;
    if (!root) return;
    let unresolved = false;
    const visited = new Set<string>();
    while (root.root_turn_id && root.root_turn_id !== root.turn_id) {
      if (visited.has(root.turn_id) || visited.size >= 16) return;
      visited.add(root.turn_id);
      const parent = (turn.get(root.thread_id,root.root_turn_id) as Turn | undefined) ?? findRoot(root.root_turn_id);
      if (!parent) { unresolved = true; break; }
      root = parent;
    }
    let owner = root.thread_id;
    const unresolvedThread = unresolved ? owner : undefined;
    const ancestry = new Set<string>();
    while (true) {
      if (ancestry.has(owner) || ancestry.size >= 16) return;
      ancestry.add(owner);
      const info = thread(owner), source = subagent(info?.source ?? '');
      const parent = edge?.get(owner)?.parent_thread_id ?? source.parent;
      if (typeof parent !== 'string') {
        if (source.internal) return;
        break;
      }
      owner = parent;
    }
    if (owner !== root.thread_id && root.root_turn_id) {
      const inParent = turn.get(owner,root.root_turn_id) as Turn | undefined;
      if (inParent && (!inParent.root_turn_id || inParent.root_turn_id === inParent.turn_id)) {
        root = inParent; unresolved = false;
      }
    }
    // An unresolved root pointer can belong to a guardian with missing state metadata.
    // Only an independently established parent edge may supply conversation-level ownership.
    if (unresolved && owner === unresolvedThread) return;
    const details = thread(owner);
    const visibleTurn = owner === root.thread_id && !unresolved;
    const turnKey = codexRunId(root);
    const key = owner + '\0' + (visibleTurn ? turnKey : '');
    if (summaries.has(key)) return summaries.get(key);
    const result: Metadata = {conversationId:chatId(owner)};
    if (visibleTurn) result.conversationTurnId = turnKey;
    const title = plainText(details?.name,100) || plainText(details?.title,100);
    if (title) result.conversationTitle = title;
    if (visibleTurn && details && typeof details.source === 'string' && details.source && !subagent(details.source).internal) {
      if (root.first_user_item_id && ask) {
        const blocks = ask.all(owner, root.turn_id, root.first_user_item_id).map(r => plainText(r.text,320)).filter(Boolean);
        const text = plainText(blocks.join(' '),320);
        if (text) result.userExcerpt = text;
      }
      if (root.final_agent_item_id && answer) {
        const text = plainText(answer.get(owner,root.turn_id,root.final_agent_item_id)?.text,320);
        if (text) result.assistantExcerpt = text;
      }
    }
    summaries.set(key,result);
    return result;
  };
}

export async function resolveCodexConversations<T extends Row>(sessions: T[], {
  databasePath = defaultCodexHistory(), statePath = join(dirname(databasePath),'state_5.sqlite'),
}: Options = {}): Promise<(T & Partial<Metadata>)[]> {
  if (!sessions.some(s => s.appName === 'Codex' && /^codex-[a-f0-9]{24}$/.test(s.runId))) return sessions;
  let db: DatabaseSync | undefined, state: DatabaseSync | undefined;
  try {
    const stamp = await stat(databasePath);
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(databasePath,{readOnly:true,allowExtension:false});
    db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-256; PRAGMA busy_timeout=25; BEGIN');
    try {
      state = new DatabaseSync(statePath,{readOnly:true,allowExtension:false});
      state.exec('PRAGMA query_only=ON; PRAGMA cache_size=-256; PRAGMA busy_timeout=25');
    } catch { /* The history still identifies turns when optional thread titles are unavailable. */ }
    const codex = sessions.filter(s => s.appName === 'Codex');
    const times = codex.flatMap(s => [s.from,s.to,s.at]).map(t => typeof t === 'string' ? Date.parse(t) : t)
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    const identityFor = readIndex(db,databasePath,[stamp.dev,stamp.ino,stamp.birthtimeMs].join('/'),
      new Set(codex.map(s => s.runId)), times);
    const describe = reader(db,state);
    const resolved = new Map<string,Metadata | undefined>();
    return sessions.map(s => {
      if (s.appName !== 'Codex') return s;
      const id = identityFor(s.runId);
      if (!id) return s;
      if (!resolved.has(s.runId)) resolved.set(s.runId,describe(id));
      const context = resolved.get(s.runId);
      return context ? {...s,...context} : s;
    });
  } catch { return sessions; }
  finally { state?.close(); db?.close(); }
}
