import { validReadingPosition, type ReadingPosition } from '../../contracts/screen-checkpoint.ts';

export type ObservationTask = { id: string; title: string; status?: string };
type Candidate = ObservationTask & { observedLine?: string };
export type PageText = { taskLabel: string; readingPage?: string; sectionHeading?: string; bodyQuote?: string;
  surfaceKind?: string; workLine?: string; codeDeclarations?: string[]; pageCounter?: string };
type Match = { task: number; taskPhrase: string; quote: string };
export type CompareWork = (tasks: readonly ObservationTask[], visibleLines: string[]) => Promise<unknown>;

export const normalize = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function readingPositionFrom(page: PageText): ReadingPosition | undefined {
  if (typeof page.pageCounter !== 'string' || page.pageCounter.length > 64 ||
      (page.readingPage !== 'body' && page.readingPage !== 'contents' && page.surfaceKind !== 'paper')) return;
  // Only a complete viewer counter qualifies. Section numbers, page ranges, zoom
  // and bare page numbers cannot provide a denominator.
  const text = normalize(page.pageCounter);
  const parts = /^(?:page\s+)?(\d{1,6})\s*(?:\/|\bof\b)\s*(\d{1,6})(?:\s+pages)?$/u.exec(text) ??
    /^(?:第\s*)?(\d{1,6})\s*页?\s*(?:\/\s*(?:共\s*)?|[，,]\s*共\s*|共\s*)(\d{1,6})\s*页$/u.exec(text);
  if (!parts) return;
  const position = { page: Number(parts[1]), total: Number(parts[2]) };
  return validReadingPosition(position) ? position : undefined;
}

export function hasBodyQuote(quote: unknown): quote is string {
  return typeof quote === 'string' && quote.trim().length >= 12 && quote.length <= 240 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]|[.…]{3,}/u.test(quote) &&
    (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{4}/u.test(quote) || (quote.match(/\p{L}+/gu) ?? []).length >= 5);
}

const academicMarker = /\b(?:arxiv|doi|research article|journal of|et al\.|abstract|in this (?:study|paper|experiment)|(?:our|this|the) (?:study|experiment|findings|participants)|(?:we|our study) (?:propose|present|investigate|evaluate|recruit|introduce|compare|demonstrate|show|train|measure)\w*|participants were|control condition|p\s*[<=>]\s*0\.\d+)\b|\[\d+(?:\s*[,–-]\s*\d+)*\]|摘要|本文(?:提出|研究|探讨|采用)|本研究|实验(?:结果|设计|组)|受试者|对照组/iu;
const tutorialTitle = /\b(?:tutorial|walkthrough|step.by.step|developer guide|getting started|how to)\b|教程|入门指南|操作指南/iu;
function researchBody(page: PageText): boolean {
  if (!page.taskLabel || page.surfaceKind !== 'paper' || page.readingPage !== 'body' || !hasBodyQuote(page.bodyQuote) || tutorialTitle.test(page.taskLabel)) return false;
  const text = [page.workLine, page.bodyQuote].join(' ');
  return academicMarker.test(text) && !/\b(?:in this tutorial|this tutorial (?:shows|explains)|follow these steps|step.by.step guide)\b|本教程|跟着以下步骤/iu.test(text);
}

function titleWords(value: string): string {
  return normalize(value).replace(/\.pdf$/u, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A named reading task constrains the document. A task with only a reading action
// and a paper noun can apply to any strongly evidenced academic article.
function readingTarget(title: string) {
  const clean = normalize(title).replace(/[《》<>"“”‘’]/gu, '').trim();
  const action = /^(?:read(?:ing)?|review|study)\s+(.+)$|^(?:阅读|精读|研读|读|看)\s*(.+)$/u.exec(clean);
  if (!action) return;
  // A second deliverable may follow a generic reading action in a compound task.
  const clauses = (action[1] ?? action[2]).split(/[,，;；、]/u);
  const extraDeliverable = /^(?:整理|梳理|总结|制作|绘制|写|做|输出|prepare\b|summari[sz]e\b|make\b|create\b)/iu;
  const readingClause = clauses.length > 1 && extraDeliverable.test(clauses[1].trim()) ? clauses[0] : (action[1] ?? action[2]);
  const object = readingClause.replace(/^(?:a|an|the|one|this|my)\s+|^(?:一篇|这篇|一份)/u, '').trim();
  const paper = '(?:(?:(?:research|academic|scientific|journal|conference)\\s+)*(?:papers?|articles?)|(?:学术|研究|科研)?(?:论文|文献))';
  if (new RegExp('^' + paper + '$', 'u').test(object)) return { generic: true, name: '' };
  const name = object.replace(new RegExp('^' + paper + '(?:\\s*[:：—-]\\s*|\\s+)|(?:\\s+|(?=[论文学术]))' + paper + '$', 'u'), '');
  return { generic: false, name: titleWords(name) };
}

function documentNamesMatch(name: string, document: string): boolean {
  const full = titleWords(document);
  if (!name || !full) return false;
  if (name === full) return true;
  // Single abbreviated names must be whole words ("BERT" cannot match "RoBERTa").
  if (/[\p{Script=Han}]/u.test(name)) return name.length >= 3 && full.includes(name);
  return name.length >= 3 && (' ' + full + ' ').includes(' ' + name + ' ');
}

/** Window titles provide a browsing clue only. Multiple matching tasks leave it unassigned. */
export function paperVisitOwner(document: string, tasks: readonly ObservationTask[], preferredId?: string): ObservationTask | undefined {
  const named: ObservationTask[] = [], generic: ObservationTask[] = [];
  for (const task of tasks) {
    const target = readingTarget(task.title);
    if (target?.generic) generic.push(task);
    else if (target && documentNamesMatch(target.name, document)) named.push(task);
  }
  const matches = named.length ? named : generic;
  return matches.length === 1 ? matches[0] : matches.find(task => task.id === preferredId);
}

const codeKind: Record<string,string> = { '类':'class', '函数':'function', '接口':'interface', '结构体':'struct', '枚举':'enum' };
function codingTarget(title: string) {
  const target = normalize(title).replace(/[`'"]/gu, '').replace(/(?:^|\s)(?:python|typescript|javascript|java|rust|golang|swift|c\+\+|c#)(?=\s|$)/gu, ' ');
  const match = /^(?:create|make|build|define|implement|write|add)\s+(?:(?:a|an|the|new)\s+)*(?:([\w$]+)\s+)?(class|function|interface|struct|enum)(?:\s+(?:(?:named|called)\s+)?([\w$]+))?$/u.exec(target.trim()) ??
    /^(?:创建|新建|定义|实现|编写|写|添加)\s*(?:一个|个)?\s*([\w$]+)?\s*(类|函数|接口|结构体|枚举)\s*([\w$]+)?$/u.exec(target.trim());
  if (!match) return;
  return { kind: codeKind[match[2]] ?? match[2], name: match[1] ?? match[3] };
}

function declarationsOnPage(page: PageText) {
  if (page.surfaceKind !== 'code') return [];
  const lines = new Set([page.workLine, ...(Array.isArray(page.codeDeclarations) ? page.codeDeclarations.slice(0,6) : [])]);
  return [...lines].flatMap(line => {
    if (typeof line !== 'string' || line.length > 200 || /\p{Cc}/u.test(line)) return [];
    const match = /^\s*(?:(?:export|default|public|private|protected|abstract|final|async|sealed|static|open|pub)\s+)*(class|function|def|func|fn|interface|struct|enum)\s+([\p{L}_$][\p{L}\p{N}_$]*)(?=[\s(<:{;]|$)/iu.exec(line);
    return match ? [{ kind: /^(?:def|func|fn)$/u.test(match[1]) ? 'function' : match[1].toLowerCase(), name: normalize(match[2]), line: line.trim() }] : [];
  });
}

export function visibleWorkFor(task: Candidate, page: PageText): string {
  if (task.observedLine) return task.observedLine;
  const target = codingTarget(task.title);
  const matched = declarationsOnPage(page).find(symbol => symbol.kind === target?.kind && (!target.name || symbol.name === target.name));
  return matched?.line ?? (typeof page.workLine === 'string' ? page.workLine.trim().slice(0,180) : '');
}

const genericWords = new Set('make create write work start finish complete read review check update add fix draft edit prepare build project task document file page data notes plan with from about and the for this new my'.split(' '));
function subjectWords(value: string): Set<string> {
  const words = new Set<string>();
  for (const [word] of normalize(value).matchAll(/[a-z0-9]+|\p{Script=Han}+/gu)) {
    if (/\p{Script=Han}/u.test(word)) {
      for (let i = 1; i < word.length; i++) words.add(word.slice(i-1,i+1));
    } else if (word.length >= 2 && /[a-z]/u.test(word) && !genericWords.has(word)) words.add(word);
  }
  return words;
}

async function otherWork(tasks: ObservationTask[], page: PageText, compare: CompareWork): Promise<Candidate[]> {
  // The language model compares blind transcriptions, never task-conditioned image guesses.
  // A copied subject must occur on both sides; generic UI words alone cannot connect a task.
  if (!['work', 'code', 'other'].includes(page.surfaceKind ?? '') || typeof page.workLine !== 'string' ||
      page.workLine.trim().length < 4 || page.workLine.length > 240 || /\p{Cc}/u.test(page.workLine)) return [];
  const rawLines = [...new Set([page.taskLabel, page.workLine, page.sectionHeading, page.bodyQuote].filter((s): s is string =>
    typeof s === 'string' && !!s.trim() && s.length <= 240 && !/\p{Cc}/u.test(s)))];
  const lines = rawLines.map(normalize);
  const onScreen = subjectWords(lines.join(' '));
  const uncertainSurface = page.surfaceKind === 'other';
  // For an unidentified application, also demand two distinct subject words and two
  // independently visible lines. A single incidental or browser-tab title is too broad.
  if (uncertainSurface && (lines.length < 2 || tutorialTitle.test(page.taskLabel))) return [];
  const related = tasks.filter(task => {
    if (readingTarget(task.title)?.generic || codingTarget(task.title)) return false;
    const shared = [...subjectWords(task.title)].filter(word => onScreen.has(word));
    return shared.length >= (uncertainSurface ? 2 : 1) &&
      (!uncertainSurface || lines.filter(line => shared.some(word => subjectWords(line).has(word))).length >= 2);
  });
  if (!related.length) return [];
  const result = await compare(related, rawLines);
  if (!Array.isArray(result) || result.length > related.length) return [];
  const evidence = new Map<string,string>();
  for (const match of result as Match[]) {
    const task = related[match?.task - 1];
    if (!Number.isInteger(match?.task) || !task || typeof match.taskPhrase !== 'string' || typeof match.quote !== 'string') continue;
    const phrase = normalize(match.taskPhrase), quote = normalize(match.quote);
    if (!phrase || quote.length < 3 || !normalize(task.title).includes(phrase) || !lines.some(line => line.includes(quote))) continue;
    const quoted = subjectWords(quote);
    if (![...subjectWords(phrase)].some(word => quoted.has(word))) continue;
    // Indistinguishable task titles remain ambiguous, even if a model picked the first row.
    for (const same of related) if (normalize(same.title) === normalize(task.title)) evidence.set(same.id, match.quote.trim());
  }
  return related.filter(t => evidence.has(t.id)).map(t => ({ ...t, observedLine: evidence.get(t.id) }));
}

export async function attributedTask(page: PageText, input: readonly ObservationTask[], owners: readonly string[],
  targetId: string | undefined, getFocus: () => Promise<string | null>, compare: CompareWork): Promise<Candidate | undefined> {
  async function resolve(candidates: Candidate[]) {
    if (candidates.length <= 1) return candidates[0];
    const selected = candidates.find(t => t.id === targetId);
    if (selected) return selected;
    const focused = await getFocus();
    return candidates.find(t => t.id === focused);
  }
  const tasks = input.filter(t => t.status !== 'done');
  const exact = tasks.filter(t => (page.taskLabel.trim() && normalize(t.title) === normalize(page.taskLabel)) || owners.includes(t.id));
  if (exact.length) return resolve(exact);
  if (researchBody(page)) {
    const named: ObservationTask[] = [], generic: ObservationTask[] = [];
    for (const task of tasks) {
      const target = readingTarget(task.title);
      if (target?.generic) generic.push(task);
      else if (target && documentNamesMatch(target.name, page.taskLabel)) named.push(task);
    }
    return resolve(named.length ? named : generic);
  }
  const declarations = declarationsOnPage(page);
  if (declarations.length) {
    const named: ObservationTask[] = [], generic: ObservationTask[] = [];
    for (const task of tasks) {
      const target = codingTarget(task.title);
      if (!target || !declarations.some(symbol => symbol.kind === target.kind && (!target.name || symbol.name === target.name))) continue;
      (target.name ? named : generic).push(task);
    }
    if (named.length || generic.length) return resolve(named.length ? named : generic);
  }
  return resolve(await otherWork(tasks, page, compare));
}
