import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecorderStatus } from '../../contracts/foreground-recorder.ts';
import { validArxivPaper, validReadingDocument, type ArxivPaper, type ScreenCheckpoint } from '../../contracts/screen-checkpoint.ts';
import { paperInWindow } from './arxiv-paper.ts';
import { CheckpointCapacityError } from './checkpoint-store.ts';
import { WriteRequestError } from './write-policy.ts';

export interface ForegroundFrame {
  image: string;
  app: string;
  pageKey: string;
  pageTitle?: string;
  paper?: ArxivPaper;
}
type ObservedPage = Pick<ScreenCheckpoint, 'taskId' | 'summary' | 'nextStep' | 'progress' | 'activityEvidence' | 'completedParts' | 'readingDocument' | 'readingSection' | 'readingPosition'>;
export interface CaptureSession {
  capture(signal: AbortSignal): Promise<ForegroundFrame | null>;
  close(): void | Promise<void>;
}
type Support = { supported: boolean; message: string };
export interface RecorderOptions {
  platform: RecorderStatus['platform'];
  support(): Promise<Support>;
  open(options: { signal: AbortSignal; onStop: (reason?: string) => void }): Promise<CaptureSession>;
  analyze(image: string, signal: AbortSignal, targetTaskId?: string): Promise<ObservedPage>;
  identifyPaper?(paper: ArxivPaper, preferredTask?: string): Promise<{title?:string; taskId:string | null}>;
  save(record: ScreenCheckpoint, signal: AbortSignal): Promise<void>;
  recordAppSpan?(appName: string, from: number, to: number): Promise<void>;
  flushAppSpans?(): Promise<void>;
  monitorAi?(signal: AbortSignal): Promise<void>;
  now?: () => number;
  pollMs?: number;
  samePageMs?: number;
}
type Sample = { frame: ForegroundFrame; capturedAt: string; targetTaskId: string | null; generation: number; previousPaper?: ArxivPaper };

function clean(value: string | undefined, limit: number) {
  return Array.from((value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()).slice(0, limit).join('');
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '前台页面记录暂时不可用，请重新开始。';
}

export function createForegroundRecorder({ platform, support, open, analyze, identifyPaper, save, recordAppSpan, flushAppSpans, monitorAi, now = Date.now, pollMs = 4_000, samePageMs = 45_000 }: RecorderOptions) {
  const status: RecorderStatus = { platform, state: 'idle', supported: true, message: '',
    savedCount: 0, lastSavedAt: null, sessionStartedAt: null, targetTaskId: null, observedTaskId: null, observedAt: null };
  let current: AbortController | undefined;
  let finished: Promise<void> = Promise.resolve();
  let targetGeneration = 0;
  let capability: { checked: number; result: Promise<Support> } | undefined;

  function getSupport() {
    if (!capability || Date.now() - capability.checked > 30_000) {
      capability = { checked: Date.now(), result: support().catch(() => ({ supported: false, message: '无法检查当前桌面的录制能力。' })) };
    }
    return capability.result;
  }
  async function readStatus() {
    if (current) return { ...status };
    const possible = await getSupport();
    if (!current && (status.state === 'idle' || status.state === 'unavailable')) {
      if (!possible.supported) Object.assign(status, { state: 'unavailable', supported: false, message: possible.message });
      else if (status.state === 'unavailable') Object.assign(status, { state: 'idle', supported: true, message: '' });
    }
    return { ...status };
  }

  function stop(reason = '记录已停止。') {
    if (current && !current.signal.aborted) {
      status.state = 'stopping';
      status.message = reason;
      current.abort();
    }
    return { ...status };
  }

  async function run(controller: AbortController, mode: 'screen' | 'ai') {
    const { signal } = controller;
    let device: CaptureSession | undefined;
    let failure = '';
    let previousApp: { name: string; at: number } | undefined;
    let draining: Promise<void> | undefined;
    let monitoring: Promise<void> | undefined;
    // Keep at most three pending samples while the local model reads an earlier page.
    const queue: Sample[] = [];
    let lastSample: { page: string; digest: string; paper?: string; at: number; generation: number } | undefined;
    let changingImage: string | undefined;
    let pendingDetail: ArxivPaper | undefined;
    let lastSaved: { at: string; page: string; facts: string; titleOnly: boolean; retryVision: boolean } | undefined;
    let retryTitleAt = 0;
    let retryStorageAt = 0;
    const storageNotice = '检查点已满，新的画面观察暂停保存。前台时长和已接入的 AI 记录继续；腾出空间后将在一分钟内重试。';
    const titleNotice = '当前只记录窗口标题。读图恢复后，可识别画面里的论文页码。';
    const modelIssues = new Set(['MODEL_CONFIG', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'INVALID_OBSERVATION', 'INCOMPLETE_OBSERVATION', 'OBSERVATION_BUSY']);

    async function record({ frame, capturedAt, targetTaskId, generation, previousPaper }: Sample, immediatePaper?: ArxivPaper) {
      let observation: ObservedPage;
      let titleOnly = false;
      const appName = clean(frame.app, 60) || '桌面应用';
      const pageTitle = clean(frame.pageTitle, 160);
      const titlePaper = paperInWindow(appName, pageTitle);
      let paper = validArxivPaper(frame.paper) ? frame.paper : titlePaper;
      if (immediatePaper) {
        observation = {taskId:null, summary:'', nextStep:'', progress:null};
      } else try {
        observation = await analyze(frame.image, signal, targetTaskId ?? undefined);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof WriteRequestError && modelIssues.has(error.code))) throw error;
        titleOnly = true;
        observation = { taskId: null, summary: pageTitle ? appName + ' 的前台页面标题为「' + pageTitle + '」。' : appName + ' 位于前台。',
          nextStep: '', progress: null, completedParts: [] };
      }
      const retryVision = titleOnly && (!paper || (paper.view === 'pdf' && !paper.position));
      if (paper) {
        if (!paper.title && titlePaper?.id === paper.id && titlePaper.title) paper = {...paper, title:titlePaper.title};
        const identity = await identifyPaper?.(paper, targetTaskId ?? observation.taskId ?? undefined);
        const title = paper.title ?? identity?.title;
        const position = paper.view === 'pdf' ? paper.position ?? observation.readingPosition : undefined;
        paper = {...paper, ...(title ? {title} : {}), ...(position ? {position} : {})};
        const document = title || 'arXiv:' + paper.id;
        const taskId = identity ? identity.taskId : observation.taskId;
        const material = observation.activityEvidence?.kind === 'reading' ? observation.activityEvidence : undefined;
        const section = observation.taskId === taskId && taskId ? observation.readingSection : undefined;
        // The preceding capture already saved the header. An independent follow-up
        // frame is worth recording only if it reveals an additional section or page.
        if (previousPaper && !section && !material?.section && (previousPaper.position || !position)) {
          if (retryVision && lastSaved?.page === frame.pageKey && capturedAt >= lastSaved.at) {
            retryTitleAt = now() + 60_000;
            lastSaved.retryVision = true;
          }
          return;
        }
        observation = {taskId, nextStep:'', progress:null, completedParts:[],
          summary:'正在查看《' + document + '》' + (position ? '（第 ' + position.page + ' 页，共 ' + position.total + ' 页）' :
            paper.view === 'abstract' ? '的摘要页' : '的 PDF') + '。',
          ...(validReadingDocument(document) ? {activityEvidence:{kind:'reading', title:document,
            ...(material?.subject ? {subject:material.subject} : {}),
            ...(material?.section || section ? {section:material?.section || section} : {})}} : {}),
          ...(taskId && (section || position) && validReadingDocument(document) ? {readingDocument:document,
            ...(section ? {readingSection:section} : {}), ...(position ? {readingPosition:position} : {})} : {})};
        titleOnly = false;
      }
      signal.throwIfAborted();
      if (retryVision) retryTitleAt = now() + 60_000;
      const activity = observation.activityEvidence;
      const facts = JSON.stringify([paper, activity?.kind, activity?.title, activity?.subject, activity?.section,
        [...(activity?.answeredItems ?? [])].sort(), [...(activity?.completedItems ?? [])].sort(), observation.taskId, observation.summary, observation.readingDocument, observation.readingSection,
        observation.readingPosition?.page, observation.readingPosition?.total, observation.progress?.percent, [...(observation.completedParts ?? [])].sort()]);
      const row: ScreenCheckpoint = { id: randomUUID(), source: 'automatic', appName, capturedAt,
        ...(pageTitle ? { pageTitle } : {}), ...(paper ? {paper} : {}), ...(titleOnly ? { detailSource: 'window-title' as const } : {}), ...observation };
      if (retryStorageAt || lastSaved?.page !== frame.pageKey || lastSaved.facts !== facts || lastSaved.titleOnly !== titleOnly) {
        try {
          await save(row, signal);
        } catch (error) {
          if (!(error instanceof CheckpointCapacityError)) throw error;
          retryStorageAt = now() + 60_000;
          status.message = storageNotice;
          queue.length = 0;
          lastSample = undefined;
          return;
        }
        retryStorageAt = 0;
        if (status.message === storageNotice) status.message = '';
        if (!lastSaved || capturedAt >= lastSaved.at) {
          lastSaved = { at:capturedAt, page:frame.pageKey, facts, titleOnly, retryVision };
          status.lastSavedAt = capturedAt;
        }
        status.savedCount++;
      }
      if (generation === targetGeneration && (!status.observedAt || capturedAt >= status.observedAt)) {
        if (!status.message || status.message === titleNotice) status.message = titleOnly ? titleNotice : '';
        status.observedTaskId = row.taskId;
        status.observedAt = capturedAt;
      }
    }

    async function drain() {
      try {
        while (queue.length && !signal.aborted) await record(queue.shift()!);
      } catch (error) {
        if (!signal.aborted) { failure = messageOf(error); controller.abort(); }
      } finally { draining = undefined; }
    }

    try {
      if (mode === 'ai') {
        if (!monitorAi) throw new Error('AI 活动记录暂时不可用。');
        Object.assign(status, { state: 'recording', supported: true, message: '', sessionStartedAt: new Date(now()).toISOString() });
        await monitorAi(signal);
        return;
      }
      const possible = await getSupport();
      signal.throwIfAborted();
      if (!possible.supported) {
        Object.assign(status, { state: 'unavailable', supported: false, message: possible.message });
        return;
      }
      device = await open({ signal, onStop: reason => stop(reason || '已从桌面停止记录。') });
      signal.throwIfAborted();
      Object.assign(status, { state: 'recording', supported: true, message: '', sessionStartedAt: new Date(now()).toISOString() });
      if (monitorAi) {
        monitoring = Promise.resolve().then(() => monitorAi(signal)).catch(() => {
          if (!signal.aborted) status.message = 'AI 活动记录暂时不可用。';
        });
      }
      while (!signal.aborted) {
        const generation = targetGeneration;
        const targetTaskId = status.targetTaskId ?? null;
        const frame = await device.capture(signal);
        signal.throwIfAborted();
        const at = now();
        const name = clean(frame?.app, 60);
        // An interval needs consecutive samples of the same foreground app. Pauses,
        // lock screens, long capture gaps and recorder restarts break continuity.
        if (name && previousApp?.name === name && at > previousApp.at && at - previousApp.at <= 12_000) {
          await recordAppSpan?.(name, previousApp.at, at);
        }
        previousApp = name ? { name, at } : undefined;
        if (frame && generation === targetGeneration && at >= retryStorageAt) {
          const header = validArxivPaper(frame.paper) ? frame.paper : paperInWindow(frame.app, frame.pageTitle);
          const paper = JSON.stringify(header);
          const changedPage = lastSample?.page !== frame.pageKey || lastSample?.generation !== generation || paper !== lastSample?.paper;
          const digest = createHash('sha256').update(frame.image).digest('hex');
          const newPixels = digest !== lastSample?.digest;
          const intervalElapsed = !lastSample || at - lastSample.at >= samePageMs;
          const retry = lastSaved?.page === frame.pageKey && lastSaved.retryVision && at >= retryTitleAt;
          // A settled PDF page is worth reading promptly. A video can change on every sample.
          if (changedPage || pendingDetail || (newPixels && (changingImage === digest || intervalElapsed)) || (retry && intervalElapsed)) {
            lastSample = { page: frame.pageKey, digest, paper, at, generation };
            changingImage = undefined;
            const sample: Sample = { frame, capturedAt: new Date(at).toISOString(), targetTaskId, generation };
            if (header && changedPage) {
              // Save a verified transition on the capture loop. Slow model work for
              // other apps cannot delay it or evict it from the bounded image queue.
              await record(sample, header);
              pendingDetail = header;
            } else {
              if (pendingDetail && !changedPage) sample.previousPaper = pendingDetail;
              pendingDetail = undefined;
              const queued = queue.at(-1);
              if (queued?.frame.pageKey === frame.pageKey && queued.generation === generation && JSON.stringify(queued.frame.paper) === JSON.stringify(frame.paper)) queue[queue.length - 1] = sample;
              else {
                if (queue.length === 3) queue.shift();
                queue.push(sample);
              }
              draining ??= drain();
            }
          } else changingImage = newPixels ? digest : undefined;
        } else {
          // An ineligible foreground (e.g. the lock screen) breaks continuity.
          lastSample = undefined;
          changingImage = undefined;
          pendingDetail = undefined;
        }
        await delay(pollMs, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) failure = messageOf(error);
    } finally {
      controller.abort();
      queue.length = 0;
      try { await device?.close(); } catch (error) { failure ||= messageOf(error); }
      await Promise.all([draining, monitoring]);
      try { if (device) await flushAppSpans?.(); } catch (error) { failure ||= messageOf(error); }
      if (failure) Object.assign(status, { state: 'error', message: failure });
      else if (status.state !== 'unavailable') status.state = 'idle';
      status.targetTaskId = null;
      delete status.mode;
      current = undefined;
    }
  }

  function start(targetTaskId: string | null = null, mode: 'screen' | 'ai' = 'screen') {
    if (!current) {
      current = new AbortController();
      Object.assign(status, { state: 'starting', mode, message: mode === 'screen' && platform === 'darwin' ? '首次使用时，请允许 macOS 的屏幕录制请求。' : '',
        targetTaskId, observedTaskId: null, observedAt: null, savedCount: 0, sessionStartedAt: null, lastSavedAt: null });
      finished = run(current, mode);
    }
    return { ...status };
  }

  function target(taskId: string | null) {
    if (status.state !== 'recording' && status.state !== 'starting') throw new WriteRequestError(409, 'NO_SESSION', '请先开始记录。');
    if (status.mode === 'ai') throw new WriteRequestError(409, 'NO_CAPTURE', '仅记录 AI 状态期间无法选择截图识别的目标任务。');
    if (status.targetTaskId !== taskId) {
      status.targetTaskId = taskId;
      status.observedTaskId = null;
      status.observedAt = null;
      targetGeneration++;
    }
    return { ...status };
  }
  return { readStatus, start, stop, target, async close() { stop(); await finished; } };
}
