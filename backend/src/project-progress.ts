import { deviceTaskLabel } from '../../contracts/device-task-label.ts';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CalendarSnapshot } from '../../contracts/calendar.ts';
import type { DailyOverview } from '../../contracts/daily-overview.ts';
import { MAX_ACCOMPLISHMENTS, accomplishmentKey, validAccomplishment, validSections, projectStatus, type ProjectPlan, type ProgressConfig, type ProjectStatus } from '../../contracts/project-progress.ts';
import type { ScreenCheckpoint } from '../../contracts/screen-checkpoint.ts';
import { paperBrowser, paperIdKey, recordedPaper } from './arxiv-paper.ts';
import { paperVisitOwner } from './reading-attribution.ts';
import { CheckpointError, createCheckpointStore } from './checkpoint-store.ts';
import { privateJson, privateInput, checkPrivateRequest } from './checkpoint-http.ts';
import { WriteRequestError } from './write-policy.ts';

// Recognize article-like titles on paper hosts. Author, discovery and search pages are too broad.
function paperWindowTitle(row: ScreenCheckpoint): string | undefined {
  if (row.source !== 'automatic' || !paperBrowser(row.appName) || !row.pageTitle) return;
  const match = /^(.+?)\s+[|｜–—-]\s+(?:alphaXiv|arXiv(?:\.org)?)$/iu.exec(row.pageTitle.trim());
  if (!match) return;
  const title = match[1].trim();
  if (/^(?:search|browse|explore|authors?|搜索|探索|首页|热门|作者)(?:\b|[\s:：]|$)/iu.test(title)) return;
  const words = title.match(/\p{L}+/gu) ?? [];
  if (/\[\d{4}\.\d{4,5}(?:v\d+)?\]/u.test(title) || words.length >= 5 ||
      (/[:：]/u.test(title) && words.length >= 3) || /\p{Script=Han}{10}/u.test(title)) return title;
}

function addPaperVisits(statuses: ProjectStatus[], overview: DailyOverview, rows: ScreenCheckpoint[], now: number) {
  const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: overview.timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
  const date = clock.format(now).slice(0, 10);
  const samples = rows.filter(row => Date.parse(row.capturedAt) <= now)
    .sort((a,b) => a.capturedAt.localeCompare(b.capturedAt));
  const titles = new Map<string,string>();
  for (const row of samples) {
    const paper = recordedPaper(row);
    if (paper?.title) titles.set(paperIdKey(paper.id), paper.title);
  }

  type Paper = NonNullable<ProjectStatus['latestPaper']>;
  const byTask = new Map<string,Map<string,Paper>>();
  const latest = new Map<string,Paper>();
  const visits = new Map<string, { minutes:Set<number>; documents:Map<string,{title:string;at:string}>; count:number }>();
  for (const row of samples) {
    const paper = recordedPaper(row);
    const key = paper && paperIdKey(paper.id);
    const title = key ? titles.get(key) || 'arXiv:' + paper!.id : paperWindowTitle(row);
    if (!title) {
      // Positive evidence of opening a different, named document takes precedence.
      // A missing title or a model's generic PDF label supplies no new identity.
      const current = row.taskId && latest.get(row.taskId);
      if (current && row.readingDocument && (row.readingSection || row.readingPosition)) {
        const doc = row.readingDocument.trim().toLowerCase();
        if (![current.title.toLowerCase(), 'arxiv:' + current.id, current.id].includes(doc) &&
            !/^(?:untitled|unknown|document|paper|pdf(?: viewer| document)?|未命名|未知|文档|论文)(?:\.pdf)?$/iu.test(doc)) latest.delete(row.taskId!);
      }
      continue;
    }
    const owner = row.taskId ? overview.tasks.find(task => task.id === row.taskId) : paperVisitOwner([title,key].filter(Boolean).join(' '), overview.tasks);
    if (!owner) continue;
    if (paper && key) {
      const documents = byTask.get(owner.id) ?? new Map<string,Paper>();
      byTask.set(owner.id, documents);
      const previous = documents.get(key);
      const previousVersion = previous?.id.match(/v\d+$/iu)?.[0];
      const version = paper.id.match(/v\d+$/iu)?.[0];
      // Different published revisions can have different pagination.
      const changedVersion = version && previousVersion && version !== previousVersion;
      const page = paper.view === 'pdf' ? paper.position ?? row.readingPosition : undefined;
      const position = page ?? (changedVersion ? undefined : previous?.position);
      const item = {id:!version && previousVersion ? previous!.id : paper.id, title, at:row.capturedAt, ...(position ? {position} : {})};
      documents.set(key, item);
      latest.set(owner.id, item);
    }
    const at = clock.format(Date.parse(row.capturedAt));
    if (at.slice(0, 10) !== date) continue;
    const visit = visits.get(owner.id) ?? { minutes:new Set<number>(), documents:new Map<string,{title:string;at:string}>(), count:0 };
    visit.minutes.add(Number(at.slice(11, 13)) * 60 + Number(at.slice(14, 16)));
    visit.count++;
    visit.documents.set(key || title, {title,at:row.capturedAt});
    visits.set(owner.id, visit);
  }
  for (const status of statuses) {
    const paper = latest.get(status.taskId);
    if (paper) status.latestPaper = paper;
    const visit = visits.get(status.taskId);
    if (!visit) continue;
    const recent = [...visit.documents.values()].sort((a,b) => b.at.localeCompare(a.at)).slice(0,5);
    status.paperVisits = { date, count:visit.count, documents:visit.documents.size, minutes:[...visit.minutes].sort((a,b)=>a-b), recent };
  }
}

function validPlan(plan: ProjectPlan) {
  if (typeof plan?.taskId !== 'string' || !validSections(plan.sections)) return false;
  const notes = plan.notes;
  if (notes !== undefined && (!Array.isArray(notes) || notes.length > MAX_ACCOMPLISHMENTS ||
      !notes.every(note => validAccomplishment(note) && note === note.trim()) ||
      new Set(notes.map(accomplishmentKey)).size !== notes.length)) return false;
  const edits = plan.stepEdits;
  return edits === undefined || (Array.isArray(edits) && edits.length <= plan.sections.length &&
    edits.every(edit => edit && typeof edit.done === 'boolean' && plan.sections.includes(edit.section)) &&
    new Set(edits.map(edit => edit.section)).size === edits.length);
}

export function createProjectProgress(dataPath: string, checkpoints: ReturnType<typeof createCheckpointStore>, load: () => Promise<DailyOverview>,
  loadCalendar?: () => Promise<CalendarSnapshot>, now = Date.now) {
  const filePath = dataPath + '.progress.json';
  let writes: Promise<unknown> = Promise.resolve();
  async function read(): Promise<ProgressConfig> {
    try {
      const config = JSON.parse(await readFile(filePath, 'utf8'));
      if (typeof config.revision !== 'string' || !Array.isArray(config.plans) ||
          !config.plans.every(validPlan) ||
          (config.pinned !== null && typeof config.pinned !== 'string')) throw Error();
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision:'initial', pinned:null, plans:[] };
      throw new CheckpointError(503,'无法读取任务进度设置。');
    }
  }
  async function update(input: Record<string,unknown>, overview: DailyOverview) {
    const state = await read();
    if (typeof input.revision !== 'string' || !input.revision) throw new CheckpointError(400,'缺少进度设置版本。');
    if (typeof input.taskId !== 'string' || !overview.tasks.some(t => t.id === input.taskId)) throw new CheckpointError(400,'请选择现有任务。');
    const id = input.taskId;
    const plan = state.plans.find(row => row.taskId === id);
    const adding = input.action === 'add-accomplishment';
    const editingNote = adding || input.action === 'remove-accomplishment';
    let note = '';
    let noteIndex = -1;
    if (editingNote) {
      if (!validAccomplishment(input.text)) throw new CheckpointError(400,'完成事项须为 1–160 个字符的单行文字。');
      note = input.text.trim();
      noteIndex = plan?.notes?.findIndex(value => accomplishmentKey(value) === accomplishmentKey(note)) ?? -1;
      // A retry after a lost response is safe when the requested state already exists.
      if (adding === (noteIndex >= 0)) return;
    }
    if (state.revision !== input.revision) throw new CheckpointError(409,'进度设置已变化，请重新载入再保存。');
    if (editingNote) {
      const target = plan ?? {taskId:id, sections:[]};
      const notes = target.notes ?? [];
      if (adding) {
        if (notes.length >= MAX_ACCOMPLISHMENTS) throw new CheckpointError(400,'每项任务最多可手动登记 64 条完成事项。');
        notes.push(note);
      } else notes.splice(noteIndex, 1);
      if (notes.length) target.notes = notes;
      else delete target.notes;
      if (!plan) state.plans.push(target);
      else if (!notes.length && !target.sections.length) state.plans = state.plans.filter(row => row !== target);
    } else if (input.action === 'plan' && validSections(input.sections)) {
      state.plans = state.plans.filter(p => p.taskId !== id && (p.notes?.length || overview.tasks.some(t => t.id === p.taskId)));
      const sections = input.sections.map(s => s.trim());
      const stepEdits = plan?.stepEdits?.filter(edit => sections.includes(edit.section));
      if (sections.length || plan?.notes?.length) {
        state.plans.push({taskId:id, sections, ...(stepEdits?.length ? {stepEdits} : {}), ...(plan?.notes?.length ? {notes:plan.notes} : {})});
      }
    } else if (input.action === 'set-step') {
      const {section, done} = input;
      if (!plan || typeof section !== 'string' || !plan.sections.includes(section) || typeof done !== 'boolean')
        throw new CheckpointError(400,'请选择清单中的步骤。');
      const task = overview.tasks.find(item => item.id === id)!;
      const evidence = projectStatus(task,{taskId:id, sections:plan.sections},(await checkpoints.read()).records);
      const edits = (plan.stepEdits ?? []).filter(edit => edit.section !== section);
      if (evidence.completed.includes(section) !== done) edits.push({section, done});
      if (edits.length) plan.stepEdits = edits;
      else delete plan.stepEdits;
    } else if (input.action === 'pin') state.pinned = id;
    else if (input.action === 'unpin') state.pinned = null;
    else throw new CheckpointError(400,'请检查步骤名称；自定义中文名称可用“中文 | English”添加设备短名。');
    state.revision = randomUUID();
    const temp = filePath + '.' + state.revision + '.tmp';
    try {
      const file = await open(temp,'wx',0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temp,filePath);
    } finally { await rm(temp,{force:true}).catch(()=>{}); }
  }
  async function withCalendarReminder(project: ProjectStatus, overview: DailyOverview): Promise<ProjectStatus> {
    if (!loadCalendar) return project;
    const otherTasks = overview.tasks.filter(task => task.status === 'todo' && task.id !== project.taskId);
    if (!otherTasks.length) return project;
    const calendar = await loadCalendar();
    const published = new Set(calendar.entries.filter(entry => entry.status === 'published').map(entry => entry.id));
    const planned = otherTasks.filter(task => published.has(task.id));
    return planned.length ? { ...project, calendarReminder: { title: deviceTaskLabel(planned[0]), count: planned.length } } : project;
  }
  return {
    async pinned(overview:DailyOverview) {
      const config = await read();
      const task = overview.tasks.find(t => t.id === config.pinned);
      if (!task) return null;
      return withCalendarReminder(projectStatus(task,config.plans.find(p=>p.taskId===task.id),(await checkpoints.read()).records), overview);
    },
    async handle(request:IncomingMessage,response:ServerResponse) {
      try {
        checkPrivateRequest(request);
        if (request.method !== 'GET' && request.method !== 'PUT') { response.setHeader('Allow','GET, PUT'); privateJson(response,405,{error:'不支持此操作。'}); return; }
        const overview = await load();
        if (request.method === 'PUT') {
          const input = await privateInput(request);
          const done = writes.then(() => update(input, overview));
          writes = done.catch(()=>{});
          await done;
        }
        const config = await read();
        const { records } = await checkpoints.read();
        const statuses = overview.tasks.map(task => projectStatus(task,config.plans.find(p=>p.taskId===task.id),records));
        addPaperVisits(statuses, overview, records, now());
        const pinned = statuses.findIndex(status => status.taskId === config.pinned);
        if (pinned >= 0) statuses[pinned] = await withCalendarReminder(statuses[pinned], overview);
        privateJson(response,200,{ config, statuses });
      } catch(error) {
        if (error instanceof CheckpointError || error instanceof WriteRequestError) privateJson(response,error.status,{error:error.message});
        else privateJson(response,503,{error:'本机进度设置暂时不可用。'});
      }
    },
  };
}
