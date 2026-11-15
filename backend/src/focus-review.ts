import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FOCUS_DURATION_MS, MAX_OVERVIEW_BYTES, type DailyOverview, type FocusSession } from '../../contracts/daily-overview.ts';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint.ts';
import type { ReviewObservation, FocusReview, ReviewExperiment, ReviewSegment } from '../../contracts/focus-review.ts';

const DAY = 86_400_000;
const RETENTION = 90 * DAY;
const MAX_SESSIONS = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export class ReviewInputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

interface Segment {
  taskId: string;
  title: string;
  start: number; // Original Hub timer, kept for idempotent reconciliation.
  from: number;  // Time covered by the recorder.
  seen: number;  // Last durable observation or actual end.
  end: Exclude<ReviewSegment['end'], 'continued'>;
}

interface Journal {
  version: 1;
  since: number;
  sessions: Segment[];
  experiments: ReviewExperiment[];
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const midnight = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(midnight) && iso(midnight).slice(0, 10) === value;
}

function offset(zone: string) {
  // These are the two civil time zones supported by the Hub task source.
  if (zone === 'Asia/Shanghai') return 8 * 3_600_000;
  if (zone === 'UTC') return 0;
  throw new ReviewInputError('回顾时区无效。');
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) < 8.64e15 - RETENTION;
}

function validSegment(s: Segment): boolean {
  return s && typeof s.taskId === 'string' && typeof s.title === 'string' &&
    validTime(s.start) && validTime(s.from) && validTime(s.seen) &&
    s.start <= s.from && s.from <= s.seen && s.seen <= s.start + FOCUS_DURATION_MS &&
    ['running', 'stopped', 'expired', 'unobserved'].includes(s.end);
}

function validExperiment(e: ReviewExperiment): boolean {
  return e && validDate(e.date) && typeof e.plan === 'string' && e.plan.trim().length > 0 && e.plan.length <= 240 &&
    typeof e.outcome === 'string' && e.outcome.length <= 480 && typeof e.revision === 'string' && e.revision.length > 0;
}

async function readSmallFile(file: string, max: number) {
  const fd = await open(file, 'r');
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > max) throw new Error('Local record is not a supported size.');
    const buf = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buf.length) {
      const { bytesRead } = await fd.read(buf, length, buf.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error('Local record changed while reading.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, length)));
  } finally { await fd.close(); }
}

async function load(file: string, activated: number): Promise<Journal> {
  let data;
  try { data = await readSmallFile(file, MAX_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, since: activated, sessions: [], experiments: [] };
    throw new ReviewInputError('每日回顾记录无法读取，原文件已保留。', 503);
  }
  if (data?.version !== 1 || !validTime(data.since) || !Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS ||
      !data.sessions.every((s: Segment, i: number) => validSegment(s) && (s.end !== 'running' || i === data.sessions.length - 1)) ||
      !Array.isArray(data.experiments) || data.experiments.length > 92 || !data.experiments.every(validExperiment)) {
    throw new ReviewInputError('每日回顾记录格式无效，原文件已保留。', 503);
  }
  return data;
}

async function store(file: string, data: Journal) {
  // One Hub owns this journal. A crash may leave one uncommitted staging file,
  // which is never used as a published record and is replaced on the next write.
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  const text = JSON.stringify(data);
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Journal full');
    try { await unlink(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
    await rename(temp, file);
  } catch {
    throw new ReviewInputError('每日回顾保存失败，请检查数据目录并重试。', 503);
  } finally { await unlink(temp).catch(() => undefined); }
}

function trim(data: Journal, now: number) {
  const floor = now - RETENTION;
  // Keep the midnight at the edge of retention intact.
  const limit = Math.floor(floor / DAY) * DAY - 8 * 3_600_000;
  data.since = Math.max(data.since, limit);
  data.sessions = data.sessions.filter(s => s.seen >= limit);
  if (data.sessions.length > MAX_SESSIONS) {
    data.since = Math.max(data.since, data.sessions[data.sessions.length - MAX_SESSIONS - 1].seen);
    data.sessions = data.sessions.slice(-MAX_SESSIONS);
  }
  data.experiments = data.experiments.filter(e => e.date >= iso(floor).slice(0, 10));
}

function shortDuration(seconds: number) {
  if (seconds < 60) return String(seconds) + ' 秒';
  return Math.floor(seconds / 60) + ' 分钟';
}

function summarize(sessions: ReviewSegment[], total: number, observations: ReviewObservation[]) {
  const last = observations.at(-1);
  const most = sessions.reduce((best, s) => !best || s.seconds > best.seconds ? s : best, null as ReviewSegment | null);
  const timer = most ? '共 ' + sessions.length + ' 段计时，合计 ' + shortDuration(total) + '。' +
    '最长一段用于「' + most.title + '」。' : '这一天没有留下专注计时记录。';
  const summary = timer + (last ? '最近一次' + checkpointSourceLabel(last.source) + '的屏幕观察写道：“' + last.summary + '”' : '');
  const next = observations.findLast(o => Boolean(o.nextStep?.trim()));
  let suggestion: FocusReview['suggestion'] = null;
  if (next) suggestion = { action: next.nextStep!, evidence: '来自' + checkpointSourceLabel(next.source) + '的屏幕观察：“' + next.summary + '”' };
  else if (most) suggestion = {
    action: '下次开始「' + most.title + '」前，写下一项能在一段计时内检查的成果。结束后记下是否做到。',
    evidence: '该任务今天有一段 ' + shortDuration(most.seconds) + ' 的计时记录。',
  };
  else if (last) suggestion = {
    action: '下次开始前写下要完成的一个动作，结束时再确认一次屏幕观察，核对前后的变化。',
    evidence: '这一天共有 ' + observations.length + ' 条屏幕观察。',
  };
  return { summary, suggestion };
}

/** The Hub's existing data lock gives this sidecar one writer. Call observe only with a successful, authoritative Hub snapshot. */
export function createFocusReview(dataPath: string, { now = Date.now }: { now?: () => number } = {}) {
  const file = path.resolve(dataPath) + '.focus-review.json';
  const activated = now();
  let journal: Journal | undefined;
  let reconciled = false;
  let latestZone = 'Asia/Shanghai';
  let lastObservation = -Infinity;
  let queue = Promise.resolve();

  function run<T>(job: (data: Journal) => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      journal ??= await load(file, activated);
      return job(journal);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(data: Journal, at: number) {
    trim(data, at);
    await store(file, data);
    journal = data;
  }

  async function remainsInSource(active: Segment) {
    // The loader projects an expired timer as null but its source still contains
    // the timer until a subsequent write. At restart this distinguishes natural
    // expiry from an unobserved removal while FocusDesk was closed.
    try {
      const raw: FocusSession | undefined = (await readSmallFile(dataPath, MAX_OVERVIEW_BYTES)).focus;
      return raw?.task_id === active.taskId && Date.parse(raw.started_at) === active.start &&
        Date.parse(raw.ends_at) === active.start + FOCUS_DURATION_MS;
    } catch { return false; }
  }

  return {
    observe(overview: Pick<DailyOverview, 'focus' | 'tasks' | 'timezone'>, cause: 'snapshot' | 'start' | 'stop' = 'snapshot') {
      const at = now();
      return run(async data => {
        if (at < lastObservation) return;
        latestZone = overview.timezone;
        const focus = overview.focus;
        const start = focus ? Date.parse(focus.started_at) : NaN;
        const last = data.sessions.at(-1);
        const same = Boolean(last && focus && last.taskId === focus.task_id && last.start === start);
        let changed = false;
        const sessions = data.sessions.slice();
        if (last?.end === 'running') {
          const expires = last.start + FOCUS_DURATION_MS;
          if (same && at < expires) {
            if (at - last.seen >= CHECKPOINT_MS) {
              sessions[sessions.length - 1] = { ...last, seen: at };
              changed = true;
            }
          } else {
            // During normal operation a stopped timer ends when the Hub confirms
            // the stop. If the process restarted, only count time we can recover.
            const verified = reconciled || (at >= expires && await remainsInSource(last));
            const end = verified ? Math.max(last.seen, Math.min(at, expires, focus ? start : Infinity)) : last.seen;
            sessions[sessions.length - 1] = { ...last, seen: end, end: !verified ? 'unobserved' : end === expires ? 'expired' : 'stopped' };
            changed = true;
          }
        }
        if (focus && !same && start <= at && at < Date.parse(focus.ends_at) && !sessions.some(s => s.start === start && s.taskId === focus.task_id)) {
          const from = start < data.since && cause !== 'start' ? at : Math.max(start, data.since);
          sessions.push({
            taskId: focus.task_id, title: overview.tasks.find(t => t.id === focus.task_id)?.title ?? focus.task_id,
            start, from, seen: Math.max(from, at), end: 'running',
          });
          changed = true;
        }
        if (changed) await persist({ ...data, sessions }, at);
        lastObservation = at;
        reconciled = true;
      });
    },

    read(date?: string, timezone?: string, observations: readonly ReviewObservation[] = []): Promise<FocusReview> {
      return run(async data => {
        const at = now();
        const zone = timezone ?? latestZone;
        const adjustment = offset(zone);
        const today = iso(at + adjustment).slice(0, 10);
        const selected = date ?? today;
        if (!validDate(selected) || selected > today) throw new ReviewInputError('请选择今天或之前的有效日期。');
        const begin = Date.parse(selected + 'T00:00:00Z') - adjustment;
        const end = begin + DAY;
        const floor = Math.max(data.since, Math.floor((at - RETENTION) / DAY) * DAY - 8 * 3_600_000);
        const sessions: ReviewSegment[] = [];
        let elapsed = 0;
        for (const s of data.sessions) {
          const from = Math.max(s.from, begin, floor);
          const until = s.end === 'running' && reconciled ? Math.max(s.seen, Math.min(at, s.start + FOCUS_DURATION_MS)) : s.seen;
          const to = Math.min(until, end);
          if (to < from || (to === from && (s.from !== from || s.from < begin || s.from >= end))) continue;
          elapsed += to - from;
          sessions.push({ taskId: s.taskId, title: s.title, from: iso(from), to: iso(to), seconds: Math.floor((to - from) / 1000),
            end: until > end ? 'continued' : s.end === 'running' && !reconciled ? 'unobserved' :
              s.end === 'running' && at >= s.start + FOCUS_DURATION_MS ? 'expired' : s.end });
        }
        const dailyObservations = observations.filter(o => typeof o.summary === 'string' && o.summary.trim() &&
          Date.parse(o.at) >= begin && Date.parse(o.at) < end && Date.parse(o.at) <= at)
          .map(({ id, at, summary, nextStep, source = 'manual' }) => ({ id, at, summary, source, ...(nextStep ? { nextStep } : {}) }))
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        const totalSeconds = Math.floor(elapsed / 1000);
        const keptExperiments = data.experiments.filter(e => e.date >= iso(at - RETENTION).slice(0, 10));
        return {
          date: selected, today, timezone: zone, trackingSince: iso(floor), partial: begin < floor,
          totalSeconds, sessions, observations: dailyObservations, ...summarize(sessions, totalSeconds, dailyObservations),
          experiment: keptExperiments.find(e => e.date === selected) ?? null,
          previousExperimentDate: keptExperiments.filter(e => e.date < selected && !e.outcome)
            .map(e => e.date).sort().at(-1) ?? null,
        };
      });
    },

    setExperiment(input: unknown) {
      return run(async data => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReviewInputError('请输入实验内容。');
        const { date, plan, outcome = '', revision } = input as Record<string, unknown>;
        const at = now();
        const today = iso(at + offset(latestZone)).slice(0, 10);
        if (!validDate(date) || date > today || date < iso(at - RETENTION).slice(0, 10)) throw new ReviewInputError('实验日期须在最近 90 天内。');
        if (typeof plan !== 'string' || !plan.trim() || plan.length > 240 ||
            typeof outcome !== 'string' || outcome.length > 480 || typeof revision !== 'string') {
          throw new ReviewInputError('请填写 1–240 字的尝试计划，复查结果限 480 字。');
        }
        const existing = data.experiments.find(e => e.date === date);
        if (revision !== (existing?.revision ?? 'none')) {
          throw new ReviewInputError('这项实验已在其他窗口更新。请核对最新记录。', 409);
        }
        const entry = { date, plan: plan.trim(), outcome: outcome.trim(), revision: randomUUID() };
        await persist({ ...data, experiments: [...data.experiments.filter(e => e.date !== date), entry] }, at);
        return entry;
      });
    },
  };
}
