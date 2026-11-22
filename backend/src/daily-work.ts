import { groupAiConversations } from '../../contracts/ai-conversations.ts';
import type { AiSession, DailyWorkActivity, ReviewObservation } from '../../contracts/focus-review.ts';
import type { ActivityEvidence } from '../../contracts/screen-checkpoint.ts';
import { paperIdKey } from './arxiv-paper.ts';

const key = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
const generic = /^(?:chatgpt|codex|new chat|untitled|document|homework|assignment|slide[s]?|pptx?|pdf|work|introduction|background|summary|新对话|新聊天|未命名(?:对话|文档)?|作业|练习|课件|学习|复习|文档|目录|引言|总结|网页对话)$/iu;
const genericSection = /^(?:chapter|section|lesson|第)\s*(?:[\divx一二三四五六七八九十百]+|one|two|three|four|five)(?:\s*[章节课])?$/iu;
type WorkItem = DailyWorkActivity['completedItems'][number];
type Group = { activity: DailyWorkActivity; completed: Set<string>; answered: Map<string,WorkItem>; aliases: Set<string> };

// Normalize simple question labels without collapsing subparts or other kinds of numbered items.
function itemId(document: string, label: string) {
  const text = key(label);
  const number = /^(?:q(?:uestion)?\.?\s*#?\s*(\d+(?:\.\d+)*)|第\s*(\d+(?:\.\d+)*)\s*题)$/u.exec(text);
  return JSON.stringify([document, number ? 'question ' + (number[1] ?? number[2]) : text]);
}

function material(row: ReviewObservation, paperTitles: Map<string,string>): ActivityEvidence | undefined {
  if (row.activityEvidence) return row.activityEvidence;
  if (row.paper) return { kind:'reading',
    title:paperTitles.get(paperIdKey(row.paper.id)) ?? 'arXiv:' + row.paper.id, section:row.readingSection };
  if (row.readingDocument && (row.readingSection || row.readingPosition)) {
    return { kind:'reading', title:row.readingDocument, section:row.readingSection };
  }
}

// Match a quoted name or topic, without matching e.g. "art" inside "Cartesian".
function mentions(text: string, alias: string): boolean {
  if (!alias || generic.test(alias) || !/[\p{L}]/u.test(alias) || alias.length < 2) return false;
  for (let at=text.indexOf(alias); at !== -1; at=text.indexOf(alias, at + alias.length)) {
    const left = !/[a-z0-9]/u.test(alias[0]) || !/[a-z0-9]/u.test(text[at-1] ?? '');
    const right = !/[a-z0-9]/u.test(alias.at(-1)!) || !/[a-z0-9]/u.test(text[at+alias.length] ?? '');
    if (left && right) return true;
  }
  return false;
}

function matchingGroup(groups: Group[], text: string): Group | undefined {
  const normalized = key(text);
  const matches = groups.filter(group => [...group.aliases].some(alias => mentions(normalized,alias)));
  return matches.length === 1 ? matches[0] : undefined;
}

function quoteExcerpt(value: string) {
  const characters = Array.from(value);
  return '「' + (characters.length > 80 ? characters.slice(0,80).join('') + '…' : value) + '」';
}

/** Deduplicated daily outcomes and a chronology of the material and actual conversation excerpts supporting them. */
export function dailyWork(observations: ReviewObservation[], sessions: AiSession[]): DailyWorkActivity[] {
  const groups = new Map<string,Group>();
  function group(id: string, title: string): Group {
    if (!groups.has(id)) groups.set(id, {activity:{title,completedItems:[],events:[]},
      completed:new Set(), answered:new Map(), aliases:new Set()});
    return groups.get(id)!;
  }

  const titles = new Map<string,string>();
  for (const row of observations) if (row.paper?.title) titles.set(paperIdKey(row.paper.id), row.paper.title);
  const materials = observations.flatMap(row => {
    const detail = material(row,titles);
    return detail ? [{row, detail}] : [];
  });
  // An unlabelled later observation may reuse the same document. Only carry the
  // subject across if this title identifies exactly one subject that day.
  const subjects = new Map<string,Map<string,string>>();
  for (const {detail} of materials) {
    if (!detail.subject) continue;
    const doc = key(detail.title);
    if (!subjects.has(doc)) subjects.set(doc,new Map());
    subjects.get(doc)!.set(key(detail.subject), detail.subject);
  }
  for (const {row, detail} of materials) {
    const doc = key(detail.title), known = subjects.get(doc);
    const subject = detail.subject ?? (known?.size === 1 ? known.values().next().value : undefined);
    const g = group(subject ? 'subject:' + key(subject) : 'document:' + doc, subject ?? detail.title);
    if (!genericSection.test(doc)) g.aliases.add(doc);
    // An explicit filename remains matchable even when the bare stem is only "Chapter One".
    const stem = doc.replace(/\.(?:pptx?|pdf|docx?|xlsx?|md|txt)$/u,'');
    if (!genericSection.test(stem)) g.aliases.add(stem);
    if (subject) g.aliases.add(key(subject));
    if (detail.section && !genericSection.test(detail.section)) g.aliases.add(key(detail.section));

    const labels = detail.kind === 'work' ? detail.completedItems ?? [] : [];
    for (const label of labels) {
      const id = itemId(doc,label);
      if (!g.completed.has(id)) {
        g.completed.add(id);
        g.answered.delete(id);
        g.activity.completedItems.push({document:detail.title,label});
      }
    }
    const markedHere = new Set(labels.map(label => itemId(doc,label)));
    const answered = detail.kind === 'work' ? (detail.answeredItems ?? []).filter(label => !markedHere.has(itemId(doc,label))) : [];
    for (const label of answered) {
      const id = itemId(doc,label);
      if (!g.completed.has(id) && !g.answered.has(id)) g.answered.set(id,{document:detail.title,label});
    }
    const location = row.paper?.position ?? row.readingPosition;
    const text = '查看《' + detail.title + '》' + (row.paper?.view === 'abstract' ? '的摘要' : '') +
      (detail.section ? ' · ' + detail.section : '') +
      (location ? ' · 第 ' + location.page + ' / ' + location.total + ' 页' : '') +
      (labels.length ? ' · 有完成标记：' + labels.join('、') : '') +
      (answered.length ? ' · 可见作答：' + answered.join('、') : '');
    g.activity.events.push({at:row.at, kind:detail.kind, text,
      source:row.source === 'automatic' ? '屏幕记录' : '手动确认', evidence:row.summary});
  }

  const materialGroups = [...groups.values()];
  for (const row of observations) {
    if (row.taskId || row.source === 'automatic' || material(row,titles)) continue;
    group('manual','手动记录').activity.events.push({at:row.at,kind:'work',text:row.summary,source:'手动确认',evidence:row.summary});
  }
  const namedChats = new Set(sessions.filter(s => s.conversationId && s.conversationTitle)
    .map(s => s.appName + ':chat:' + s.conversationId + '\0' + s.conversationTitle));
  for (const chat of groupAiConversations(sessions)) {
    const explicitTitle = namedChats.has(chat.key + '\0' + chat.title) && !generic.test(chat.title) ? chat.title : '';
    for (const turn of chat.turns) {
      const question = turn.userExcerpt?.trim(), answer = turn.assistantExcerpt?.trim();
      if (!question && !answer && !explicitTitle) continue;
      const excerpt = [question,answer].filter(Boolean).join(' ');
      const target = matchingGroup(materialGroups,[excerpt,explicitTitle].join(' '));
      const title = explicitTitle || question?.slice(0,72) || chat.appName + ' 对话';
      const ownKey = chat.linked ? chat.key : chat.key + ':' + turn.id;
      const g = target ?? group('conversation:' + ownKey,title);
      const evidence = [explicitTitle && '对话《' + explicitTitle + '》', question && '提问：' + question, answer && '回复：' + answer].filter(Boolean).join('\n');
      const text = [question && '提问' + quoteExcerpt(question), answer && '回复' + quoteExcerpt(answer)]
        .filter(Boolean).join(' · ') || '对话《' + explicitTitle + '》';
      g.activity.events.push({at:new Date(turn.from).toISOString(),kind:'discussion', text,
        source:chat.appName, evidence});
    }
  }
  const activities = [...groups.values()].map(g => {
    const a = g.activity;
    if (g.answered.size) a.answeredItems = [...g.answered.values()];
    a.events.sort((x,y) => x.at.localeCompare(y.at));
    // Keep the first source when the same material stays on screen. A new page,
    // completion mark or intervening discussion starts a separate timeline entry.
    a.events = a.events.filter((e,i,events) => i === 0 || e.kind === 'discussion' ||
      e.source !== events[i-1].source || e.text !== events[i-1].text || e.kind !== events[i-1].kind);
    return a;
  });
  return activities.sort((a,b) => a.events[0].at.localeCompare(b.events[0].at));
}
