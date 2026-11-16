import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { isIPv4 } from 'node:net';
import { MAX_OVERVIEW_BYTES, parseDailyOverview, type Task, type FocusSession } from '../../contracts/daily-overview.ts';
import type { WorkState, WorkSignal } from '../../contracts/work-state.ts';

export interface DesktopSource {
  date: string;
  timezone: string;
  tasks: Task[];
  focus?: FocusSession | null;
  work_state?: WorkState;
  signals?: WorkSignal[];
  ai_suggestion?: string;
}

export class ImportSourceError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ImportSourceError'; this.code = code; }
}

/** Validate raw legacy task sources without expiring or rewriting their focus. */
export function validateDesktopSource(source: unknown): DesktopSource {
  try {
    if (typeof source === 'string') {
      if (Buffer.byteLength(source) > MAX_OVERVIEW_BYTES) throw new Error('Too large');
      source = JSON.parse(source);
    }
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        Object.keys(source).some(key => !['date', 'timezone', 'tasks', 'focus', 'work_state', 'signals', 'ai_suggestion'].includes(key))) throw new Error('Invalid source fields');
    if (Buffer.byteLength(JSON.stringify(source)) > MAX_OVERVIEW_BYTES) throw new Error('Too large');
    const input = source as Record<string, unknown>;
    const valid = parseDailyOverview({ schema_version: '1.0', revision: '0'.repeat(64), updated_at: new Date().toISOString(), date: input.date, timezone: input.timezone, tasks: input.tasks, focus: input.focus, work_state: input.work_state, signals: input.signals, ai_suggestion: input.ai_suggestion });
    if (!['Asia/Shanghai', 'UTC'].includes(valid.timezone)) throw new Error('Unsupported device profile');
    const result: DesktopSource = { date: valid.date, timezone: valid.timezone, tasks: valid.tasks };
    if (input.focus !== undefined) result.focus = valid.focus;
    if (input.work_state !== undefined) result.work_state = valid.work_state;
    if (input.signals !== undefined) result.signals = valid.signals;
    if (input.ai_suggestion !== undefined) result.ai_suggestion = valid.ai_suggestion;
    return result;
  } catch {
    throw new ImportSourceError('IMPORT_INVALID_SOURCE', 'Import must be a valid device-compatible task source of at most 4096 bytes.');
  }
}

/** Read local files with a byte limit before allocating/parsing their content. */
export async function readDesktopFile(filename: string): Promise<{ bytes: Buffer; mtime: Date }> {
  const file = await open(filename, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_OVERVIEW_BYTES) throw new Error('Invalid or oversized data file');
    const buffer = Buffer.alloc(MAX_OVERVIEW_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_OVERVIEW_BYTES) throw new Error('Oversized data file');
    return { bytes: buffer.subarray(0, bytes), mtime: info.mtime };
  } finally { await file.close(); }
}

async function createIfMissing(filename: string, content: string) {
  let file;
  try { file = await open(filename, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
}

export async function ensureDesktopData(userRoot: string) {
  const root = path.resolve(userRoot);
  const dataDirectory = path.join(root, 'data');
  const logsPath = path.join(root, 'logs');
  const backupsPath = path.join(root, 'backups');
  const configDirectory = path.join(root, 'config');
  await Promise.all([dataDirectory, logsPath, backupsPath, configDirectory].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  const dataPath = path.join(dataDirectory, 'tasks.json');
  const configPath = path.join(configDirectory, 'focusdesk.config.json');
  await createIfMissing(dataPath, JSON.stringify({ date: `${part('year')}-${part('month')}-${part('day')}`, timezone: 'Asia/Shanghai', tasks: [] }, null, 2) + '\n');
  await createIfMissing(configPath, JSON.stringify({ host: '0.0.0.0', port: 8787 }, null, 2) + '\n');
  const existing = await readDesktopFile(dataPath);
  validateDesktopSource(new TextDecoder('utf-8', { fatal: true }).decode(existing.bytes));
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readDesktopFile(configPath)).bytes));
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['host', 'port'].includes(key)) ||
      (config.host !== undefined && (typeof config.host !== 'string' || !isIPv4(config.host))) ||
      (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535))) {
    throw new Error('Desktop configuration is invalid; existing files were not overwritten.');
  }
  return { userRoot: root, dataPath, configPath, logsPath, backupsPath };
}
