import type { Task } from './daily-overview.ts';
import { validReadingDocument, validReadingPosition, type CheckpointSource, type ReadingPosition, type ScreenCheckpoint } from './screen-checkpoint.ts';

export interface ProjectPlan {
  taskId: string;
  sections: string[];
  stepEdits?: {section:string; done:boolean}[];
}

export interface ProgressConfig {
  revision: string;
  pinned: string | null;
  plans: ProjectPlan[];
}

export interface ReadingLocation {
  id: string;
  section: string;
  document?: string;
  source: CheckpointSource;
  confirmed: boolean;
  capturedAt: string;
}

export interface ProjectStatus {
  /** First unfinished scheduled task to show alongside the pinned project. */
  calendarReminder?: { title: string; count: number };
  taskId: string;
  title: string;
  deviceTitle?: string;
  percent: number | null;
  total: number | null;
  completed: string[];
  remaining: string[];
  evidence: string | null;
  evidenceSource?: CheckpointSource;
  automaticParts?: string[];
  readingBookmark?: { current: ReadingLocation; previous?: ReadingLocation };
  /** The open page in a document, independent of task completion. */
  readingPosition?: ReadingPosition & { document?: string; section?: string };
  /** Today's paper-like window titles. Observations alone provide no completion percentage. */
  paperVisits?: { date: string; count: number; documents: number; minutes: number[]; recent: { title: string; at: string }[] };
  latestObservation?: { summary: string; capturedAt: string; source?: CheckpointSource };
}

const translations: Record<string, string> = {
  '摘要': 'Abstract', '引言': 'Introduction', '绪论': 'Introduction', '相关工作': 'Related Work',
  '方法': 'Method', '实验': 'Experiments', '结果': 'Results', '讨论': 'Discussion', '结论': 'Conclusion',
  methods: 'Method', methodology: 'Method', introductions: 'Introduction', conclusions: 'Conclusion',
};

const sectionNumber = /^(?:section\s+)?(\d+(?:\.\d+)*)[\s.):、-]+/iu;

export function devicePart(value: string, planSections: readonly string[] = []): string | null {
  const name = value.split('|').at(-1)!.trim();
  if (/^[\x20-\x7e]+$/.test(name)) return name;
  const number = name.match(sectionNumber);
  const english = translations[name.replace(sectionNumber, '')];
  if (english) return number ? number[1] + '. ' + english : english;
  const alias = planSections.find(entry => entry.split('|').some(label => sectionKey(label) === sectionKey(name)));
  const shortName = alias?.split('|')[1]?.trim();
  return shortName && /^[\x20-\x7e]+$/.test(shortName) ? shortName : null;
}

function sectionKey(value: string): string {
  const name = value.trim().replace(sectionNumber, '').toLowerCase();
  return (translations[name] ?? name).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function validSections(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 24) return false;
  const seen = new Set<string>();
  return value.every(line => {
    if (typeof line !== 'string' || !line.trim() || line.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(line)) return false;
    const labels = line.split('|').map(chunk => chunk.trim());
    if (labels.length > 2 || labels.some(part => !part || part.length > 64)) return false;
    if (labels.length === 2 && !devicePart(line)) return false;
    const keys = new Set(labels.map(sectionKey));
    if ([...keys].some(k => !k || seen.has(k))) return false;
    keys.forEach(k => seen.add(k));
    return true;
  });
}

function readingState(rows: ScreenCheckpoint[], sections: string[]): Pick<ProjectStatus, 'readingBookmark' | 'readingPosition'> {
  const sectionIndex = (key: string) => sections.findIndex(section => section.split('|').some(alias => sectionKey(alias) === key));
  const documentKey = (name?: string) => name?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  const locationKey = (row: ScreenCheckpoint) => JSON.stringify([documentKey(row.readingDocument) || row.id, sectionKey(row.readingSection!)]);
  const visited = new Set<string>();
  const confirmed = new Set<string>();
  let current: ScreenCheckpoint | undefined;
  let previous: ScreenCheckpoint | undefined;
  let position: ProjectStatus['readingPosition'];

  for (const row of rows) {
    if (row.detailSource === 'window-title') continue;
    const doc = documentKey(row.readingDocument);
    const section = row.readingSection;
    const key = section ? sectionKey(section) : '';
    const page = validReadingDocument(row.readingDocument) && validReadingPosition(row.readingPosition) ? row.readingPosition : undefined;

    if (page) {
      const samePage = position && doc === documentKey(position.document) && position.page === page.page && position.total === page.total;
      const knownSection = section ?? (samePage ? position?.section : undefined);
      position = { page: page.page, total: page.total, document: row.readingDocument, ...(knownSection ? {section:knownSection} : {}) };
      if (!section && !samePage) { current = undefined; previous = undefined; }
    } else if (section && position) {
      // A newer heading can retain an earlier page only when both document and section agree.
      position = doc && doc === documentKey(position.document) && position.section && key === sectionKey(position.section)
        ? { ...position, section } : undefined;
    }
    if (!section) continue;

    const visit = JSON.stringify([doc, key]);
    const lastKey = current?.readingSection ? sectionKey(current.readingSection) : '';
    if (!doc || doc !== documentKey(current?.readingDocument)) previous = undefined;
    else if (key !== lastKey) {
      const from = sectionIndex(lastKey), to = sectionIndex(key);
      const forward = from >= 0 && to >= 0 ? to > from : !visited.has(visit);
      previous = forward ? current : undefined;
    }
    visited.add(visit);
    current = row;
    if (row.readingConfirmed) confirmed.add(locationKey(row));
  }

  function location(row: ScreenCheckpoint): ReadingLocation {
    return { id: row.id, section: row.readingSection!, ...(row.readingDocument ? {document:row.readingDocument} : {}),
      source: row.source ?? 'manual', capturedAt: row.capturedAt, confirmed: confirmed.has(locationKey(row)) };
  }
  return {
    ...(position ? {readingPosition:position} : {}),
    ...(current ? {readingBookmark:{current:location(current), ...(previous ? {previous:location(previous)} : {})}} : {}),
  };
}

export function projectStatus(task: Task, plan: ProjectPlan | undefined, records: ScreenCheckpoint[]): ProjectStatus {
  const rows = records.filter(row => row.taskId === task.id)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const observed = new Map<string, string>();
  const reviewed = new Set<string>();
  const sections = plan?.sections ?? [];
  for (const row of rows) {
    if (row.readingConfirmed && row.readingSection) {
      const key = sectionKey(row.readingSection);
      observed.set(key, row.readingSection);
      reviewed.add(key);
    }
    for (const part of row.completedParts ?? []) {
      const key = sectionKey(part);
      observed.set(key, part);
      if (row.source !== 'automatic') reviewed.add(key);
    }
  }

  const observation = rows.filter(row => row.detailSource !== 'window-title' && row.summary?.trim()).at(-1);
  const identity = { taskId:task.id, title:task.title, ...(task.device_title ? {deviceTitle:task.device_title} : {}), ...readingState(rows, sections),
    ...(observation ? {latestObservation:{summary:observation.summary, capturedAt:observation.capturedAt, source:observation.source ?? 'manual'}} : {}) };
  if (sections.length) {
    const completed: string[] = [];
    const remaining: string[] = [];
    for (const section of sections) {
      const found = plan?.stepEdits?.find(edit => edit.section === section)?.done ?? section.split('|').some(name => observed.has(sectionKey(name)));
      (found ? completed : remaining).push(section);
    }
    return {
      ...identity, percent: Math.round(100 * completed.length / sections.length),
      total: sections.length, completed, remaining, evidence: null,
      automaticParts: completed.filter(s => !plan?.stepEdits?.some(edit => edit.section === s) && !s.split('|').some(name => reviewed.has(sectionKey(name)))),
    };
  }

  const latest = rows.filter(row => row.progress !== null).at(-1);
  const progress = latest?.progress;
  return {
    ...identity, percent: progress?.percent ?? null, total: null,
    completed: [...observed.values()], remaining: [], evidence: progress?.evidence ?? null,
    ...(progress ? { evidenceSource: latest?.source ?? 'manual' } : {}),
    automaticParts: [...observed].filter(([key]) => !reviewed.has(key)).map(([, name]) => name),
  };
}
