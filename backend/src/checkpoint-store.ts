import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { validReadingDocument, validReadingSection, type ScreenCheckpoint, type CheckpointHistory } from '../../contracts/screen-checkpoint.ts';

export const CHECKPOINT_LIMIT = 1000;
export class CheckpointError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function inputError(): never { throw new CheckpointError(400, '检查点格式无效，请检查时间、摘要和进度依据。'); }
function text(value: unknown, limit: number, optional = false): string {
  if (typeof value !== 'string' || value.trim().length > limit || (!optional && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) inputError();
  return value.trim();
}
export function checkpointId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) inputError();
  return value.toLowerCase();
}
function parseRecord(row: Partial<ScreenCheckpoint>): ScreenCheckpoint {
  if (!row || typeof row !== 'object') inputError();
  const id = checkpointId(row.id);
  const source = row.source === undefined ? 'manual' : row.source;
  const appName = row.appName === undefined ? undefined : text(row.appName, 120);
  const pageTitle = row.pageTitle === undefined ? undefined : text(row.pageTitle, 320);
  if (pageTitle && (!appName || [...pageTitle].length > 160 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(pageTitle))) inputError();
  if ((source !== 'manual' && source !== 'automatic') || (appName && (source !== 'automatic' || /\p{Cc}/u.test(appName))) ||
      (source === 'automatic' && !row.taskId && !appName)) inputError();
  if (row.detailSource !== undefined && (row.detailSource !== 'window-title' || !appName || row.taskId !== null || row.nextStep)) inputError();
  if (typeof row.capturedAt !== 'string' || !Number.isFinite(Date.parse(row.capturedAt)) ||
      new Date(row.capturedAt).toISOString() !== row.capturedAt) inputError();
  if (row.taskId !== null && (typeof row.taskId !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(row.taskId))) inputError();
  let progress: ScreenCheckpoint['progress'] = null;
  if (row.progress !== null) {
    if (!row.taskId || !row.progress || !Number.isInteger(row.progress.percent) || row.progress.percent < 0 || row.progress.percent > 100) inputError();
    progress = { percent: row.progress.percent, evidence: text(row.progress.evidence, 300) };
  }
  const parts = row.completedParts ?? [];
  if (!Array.isArray(parts) || parts.length > 8) inputError();
  const completedParts = [...new Set(parts.map(part => text(part, 64)))];
  if (source === 'automatic' && !row.taskId && completedParts.length) inputError();
  if (row.readingSection !== undefined && (!row.taskId || !validReadingSection(row.readingSection))) inputError();
  if (row.readingDocument !== undefined && (!row.readingSection || !validReadingDocument(row.readingDocument))) inputError();
  if (row.readingConfirmed !== undefined && (row.readingConfirmed !== true || !row.readingSection)) inputError();
  return { completedParts, source, ...(appName ? {appName} : {}), ...(pageTitle ? {pageTitle} : {}), ...(row.detailSource ? {detailSource:row.detailSource} : {}),
    ...(row.readingSection ? {readingSection:row.readingSection.trim()} : {}),
    ...(row.readingDocument ? {readingDocument:row.readingDocument.trim()} : {}),
    ...(row.readingConfirmed ? {readingConfirmed:true} : {}), id, capturedAt: row.capturedAt, taskId: row.taskId, summary: text(row.summary, 500), nextStep: text(row.nextStep, 350, true), progress };
}

export function createCheckpointStore(dataPath: string) {
  const filename = dataPath + '.checkpoints.json';
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = tail.then(run, run);
    tail = pending.catch(() => {});
    return pending;
  }
  async function read(): Promise<CheckpointHistory> {
    try {
      const raw = JSON.parse(await readFile(filename, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > CHECKPOINT_LIMIT) throw new Error('format');
      return { records: raw.records.map(parseRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] };
      throw new CheckpointError(503, '无法读取本机检查点。请检查任务数据目录。');
    }
  }
  async function persist(state: CheckpointHistory) {
    const temp = filename + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, ...state })); await file.sync(); } finally { await file.close(); }
      await rename(temp, filename);
    } catch { throw new CheckpointError(503, '检查点未能保存，请检查本机磁盘后重试。'); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  return {
    read: () => serial(read),
    reviewedDocuments(taskId: string) {
      return serial(async () => {
        const { records } = await read();
        return [...new Set(records.flatMap(row => row.taskId === taskId && row.source !== 'automatic' && row.readingDocument ? [row.readingDocument] : []))];
      });
    },
    add(input: ScreenCheckpoint, signal?: AbortSignal) {
      const record = parseRecord(input);
      if (record.readingConfirmed) inputError();
      return serial(async () => {
        signal?.throwIfAborted();
        const state = await read();
        const existing = state.records.find(row => row.id === record.id);
        if (existing) {
          const savedObservation = { ...existing };
          delete savedObservation.readingConfirmed;
          if (JSON.stringify(savedObservation) !== JSON.stringify(record)) throw new CheckpointError(409, '该检查点的内容已变化，请刷新后重试。');
          return;
        }
        if (state.records.length >= CHECKPOINT_LIMIT) throw new CheckpointError(409, '检查点已满，请先移除不再需要的记录。');
        signal?.throwIfAborted();
        state.records.push(record);
        await persist(state);
      });
    },
    confirmReading(value: unknown, section: unknown) {
      const id = checkpointId(value);
      if (!validReadingSection(section)) inputError();
      return serial(async () => {
        const state = await read();
        const row = state.records.find(item => item.id === id);
        if (!row || row.readingSection !== section) throw new CheckpointError(409, '阅读书签已变化，请重新载入。');
        if (!row.readingConfirmed) {
          row.readingConfirmed = true;
          await persist(state);
        }
      });
    },
    remove(value: unknown) {
      const id = checkpointId(value);
      return serial(async () => {
        const state = await read();
        if (state.records.some(row => row.id === id)) {
          state.records = state.records.filter(row => row.id !== id);
          await persist(state);
        }
      });
    },
  };
}
