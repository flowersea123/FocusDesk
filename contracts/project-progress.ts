import type { Task } from './daily-overview.ts';
import type { CheckpointSource, ScreenCheckpoint } from './screen-checkpoint.ts';

export interface ProjectPlan {
  taskId: string;
  sections: string[];
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
  taskId: string;
  title: string;
  percent: number | null;
  total: number | null;
  completed: string[];
  remaining: string[];
  evidence: string | null;
  evidenceSource?: CheckpointSource;
  automaticParts?: string[];
  readingBookmark?: { current: ReadingLocation; previous?: ReadingLocation };
}

const translations: Record<string, string> = {
  '摘要': 'Abstract', '引言': 'Introduction', '绪论': 'Introduction', '相关工作': 'Related Work',
  '方法': 'Method', '实验': 'Experiments', '结果': 'Results', '讨论': 'Discussion', '结论': 'Conclusion',
  methods: 'Method', methodology: 'Method', introductions: 'Introduction', conclusions: 'Conclusion',
};

export function devicePart(value: string): string | null {
  const name = value.split('|').at(-1)!.trim();
  if (/^[\x20-\x7e]+$/.test(name)) return name;
  return translations[name] ?? null;
}

function sectionKey(value: string): string {
  const name = value.trim().replace(/^(?:section\s+)?\d+(?:\.\d+)*[\s.):、-]+/iu, '').toLowerCase();
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

export function projectStatus(task: Task, plan: ProjectPlan | undefined, records: ScreenCheckpoint[]): ProjectStatus {
  const rows = records.filter(row => row.taskId === task.id)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const observed = new Map<string, string>();
  const reviewed = new Set<string>();
  const sections = plan?.sections ?? [];
  const knownSectionIndex = (name: string) => sections.findIndex(section => section.split('|').some(alias => sectionKey(alias) === name));
  const visited = new Set<string>();
  const confirmedLocations = new Set<string>();
  const documentKey = (row: ScreenCheckpoint) => row.readingDocument?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  const locationKey = (row: ScreenCheckpoint) => JSON.stringify([documentKey(row) || row.id, sectionKey(row.readingSection!)]);
  let currentDocument = '';
  let currentKey = '';
  let currentReading: ScreenCheckpoint | undefined;
  let previousReading: ScreenCheckpoint | undefined;
  for (const row of rows) {
    if (row.readingSection) {
      const section = sectionKey(row.readingSection);
      const document = documentKey(row);
      const visit = JSON.stringify([document, section]);
      if (!document || document !== currentDocument) previousReading = undefined;
      else if (currentKey !== section) {
        const from = knownSectionIndex(currentKey), to = knownSectionIndex(section);
        const movingForward = from >= 0 && to >= 0 ? to > from : !visited.has(visit);
        previousReading = movingForward ? currentReading : undefined;
      }
      currentDocument = document;
      currentKey = section;
      visited.add(visit);
      currentReading = row;
      if (row.readingConfirmed) {
        confirmedLocations.add(locationKey(row));
        observed.set(section, row.readingSection);
        reviewed.add(section);
      }
    }
    for (const part of row.completedParts ?? []) {
      const key = sectionKey(part);
      observed.set(key, part);
      if (row.source !== 'automatic') reviewed.add(key);
    }
  }

  function readingLocation(row: ScreenCheckpoint): ReadingLocation {
    const section = row.readingSection!;
    return { id: row.id, section, ...(row.readingDocument ? {document: row.readingDocument} : {}), source: row.source ?? 'manual', capturedAt: row.capturedAt, confirmed: confirmedLocations.has(locationKey(row)) };
  }
  const identity = { taskId: task.id, title: task.title,
    ...(currentReading ? {readingBookmark: {current: readingLocation(currentReading),
      ...(previousReading ? {previous: readingLocation(previousReading)} : {})}} : {}) };
  if (sections.length) {
    const completed: string[] = [];
    const remaining: string[] = [];
    for (const section of sections) {
      const found = section.split('|').some(name => observed.has(sectionKey(name)));
      (found ? completed : remaining).push(section);
    }
    return {
      ...identity, percent: Math.round(100 * completed.length / sections.length),
      total: sections.length, completed, remaining, evidence: null,
      automaticParts: completed.filter(s => !s.split('|').some(name => reviewed.has(sectionKey(name)))),
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
