import { deviceTaskLabel } from '../../contracts/device-task-label.ts';
import { createHash } from 'node:crypto';
import { createFocusReview } from './focus-review.ts';
import { createAiActivitySources } from './ai-activity-sources.ts';
import { monitorAiActivity } from './ai-activity.ts';
import type { AiActivitySource } from './ai-activity-types.ts';
import { createReviewHttp } from './focus-review-http.ts';
import { createProjectProgress } from './project-progress.ts';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createOverviewLoader, FocusActiveError, RevisionConflictError, SourceError } from './overview-loader.ts';
import { MAX_OVERVIEW_BYTES, OverviewValidationError, type DailyOverview } from '../../contracts/daily-overview.ts';
import { parseTaskUpdateText } from '../../contracts/task-update.ts';
import { parseFocusUpdateText } from '../../contracts/focus-update.ts';
import { parseWorkStateUpdateText } from '../../contracts/work-state.ts';
import { parseAISuggestionUpdateText } from '../../contracts/ai-suggestion.ts';
import { buildDisplaySnapshot, buildProjectDisplay } from '../../contracts/display-snapshot.ts';
import { checkWritePolicy, isLoopback, readUpdateBody, WriteRequestError } from './write-policy.ts';
import { getServerInfo } from './network-info.ts';
import { fileURLToPath } from 'node:url';
import { createCheckpointStore } from './checkpoint-store.ts';
import { checkPrivateRequest, createCheckpointHttp, privateInput, privateJson } from './checkpoint-http.ts';
import { CalendarError } from '../../contracts/calendar.ts';
import { createScreenObservationService } from './screen-observation.ts';
import { createForegroundRecorder, type RecorderOptions } from './foreground-recorder.ts';
import { createRecorderHttp } from './recorder-http.ts';

/** Older firmware reads the task DTO directly and can only draw ASCII. */
function deviceOverview(overview: DailyOverview) {
  const tasks = overview.tasks.map(task => ({
    id:task.id, title:deviceTaskLabel(task), status:task.status, due_at:task.due_at,
  }));
  const device = {...overview, tasks};
  if (Buffer.byteLength(JSON.stringify(device)) > MAX_OVERVIEW_BYTES) {
    for (const [i,task] of tasks.entries()) {
      if (!overview.tasks[i].device_title && Buffer.byteLength(JSON.stringify(task.title)) > Buffer.byteLength(JSON.stringify(overview.tasks[i].title))) task.title = String(i+1);
    }
  }
  return device;
}

const API_PATH = '/api/v1/daily-overview';
const UPDATE_PATH = `${API_PATH}/tasks`;
const FOCUS_PATH = `${API_PATH}/focus`;
const WORK_STATE_PATH = `${API_PATH}/work-state`;
const AI_SUGGESTION_PATH = `${API_PATH}/ai-suggestion`;
const DISPLAY_PATH = '/api/v1/display-snapshot';
const CONNECT_PAGE = fileURLToPath(new URL('../public/connect.html', import.meta.url));
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.zip': 'application/zip', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function send(response: ServerResponse, status: number, body: string | Buffer, type: string, head: boolean) {
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(head ? undefined : body);
}

function json(response: ServerResponse, status: number, code: string, message: string, head: boolean) {
  send(response, status, JSON.stringify({ error: { code, message } }), 'application/json; charset=utf-8', head);
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

type RecorderDriver = Pick<RecorderOptions, 'support' | 'open' | 'pollMs' | 'samePageMs'>;
export function createDemoServer({ dataPath, distPath, writeTimeoutMs = 5_000, now, loader: sharedLoader, recorderDriver, aiSourceFactory, aiPollMs }: {
  dataPath: string; distPath: string; writeTimeoutMs?: number; now?: () => number;
  loader?: ReturnType<typeof createOverviewLoader>; recorderDriver?: RecorderDriver;
  aiSourceFactory?: (signal: AbortSignal) => AiActivitySource; aiPollMs?: number;
}) {
  const loader = sharedLoader ?? createOverviewLoader(dataPath, { now });
  const root = path.resolve(distPath);
  const checkpoints = createCheckpointStore(dataPath);
  const checkpointHttp = createCheckpointHttp(checkpoints, () => loader.load());
  const reviews = createFocusReview(dataPath, { now });
  const aiSources = createAiActivitySources({ now });
  const reviewHttp = createReviewHttp(reviews, checkpoints, () => loader.load());
  let reviewUnavailable = false;
  async function observe(overview: DailyOverview, cause: 'start' | 'stop' | 'snapshot' = 'snapshot') {
    try {
      await reviews.observe(overview, cause);
      reviewUnavailable = false;
    } catch {
      // A review history write can fail after a successful task update.
      if (!reviewUnavailable) console.warn('FocusDesk could not update the focus review history.');
      reviewUnavailable = true;
    }
  }
  const projects = createProjectProgress(dataPath, checkpoints, () => loader.load(), () => loader.readCalendar(), now);
  const normalizeTitle = (title: string) => title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const screenObservation = createScreenObservationService({
    getTasks: async () => (await loader.load()).tasks,
    getFocusTaskId: async () => (await loader.load()).focus?.task_id ?? null,
    getKnownDocuments: taskId => checkpoints.reviewedDocuments(taskId),
    getDocumentOwners: async title => {
      const key = normalizeTitle(title);
      const { records } = await checkpoints.read();
      return records.flatMap(r => r.taskId && r.readingDocument && r.source !== 'automatic' &&
        normalizeTitle(r.readingDocument) === key ? [r.taskId] : []);
    },
  });
  const platform = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'other';
  const driver = () => platform === 'darwin' ? import('./foreground-mac/adapter.ts') : import('./foreground-platform/index.ts');
  const recorder = createForegroundRecorder({
    platform,
    support: async () => (await driver()).foregroundSupport(),
    open: async options => (await driver()).openForegroundCapture(options),
    ...recorderDriver,
    monitorAi: signal => monitorAiActivity(aiSourceFactory ? aiSourceFactory(signal) : aiSources.open(signal), reviews.aiActivity, signal, now, aiPollMs),
    now, recordAppSpan: reviews.recordAppSpan, flushAppSpans: reviews.flushAppSpans,
    analyze: screenObservation.foreground,
    save: async (record, signal) => {
      if (record.taskId && !(await loader.load()).tasks.some(task => task.id === record.taskId && task.status === 'todo')) {
        record.taskId = null;
        record.progress = null;
        record.completedParts = [];
        delete record.readingSection;
        delete record.readingDocument;
        delete record.readingPosition;
      }
      await checkpoints.add(record, signal);
    },
  });
  const recorderHttp = createRecorderHttp(recorder, async id => (await loader.load()).tasks.some(t => t.id === id && t.status === 'todo'));
  const server = createServer(async (request, response) => {
    const head = request.method === 'HEAD';
    try {
      let pathname: string;
      try {
        pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
      } catch {
        json(response, 400, 'INVALID_PATH', 'Malformed request path.', head);
        return;
      }
      const segments = pathname.split('/');
      if (!pathname.startsWith('/') || /[\\\x00-\x1f:]/.test(pathname) || segments.some(part => part === '..' || (part.startsWith('.') && part !== ''))) {
        json(response, 403, 'FORBIDDEN_PATH', 'Path is not available.', head);
        return;
      }
      if (pathname === '/api/v1/ai-browser') { await aiSources.handle(request, response); return; }
      if (pathname === '/api/v1/calendar') {
        try {
          checkPrivateRequest(request);
          if (request.method === 'GET') privateJson(response,200,await loader.readCalendar());
          else if (request.method === 'PUT' || request.method === 'DELETE')
            privateJson(response,200,await loader.updateCalendar(request.method,await privateInput(request)));
          else { response.setHeader('Allow','GET, PUT, DELETE'); privateJson(response,405,{error:'不支持此日历操作。'}); }
        } catch (error) {
          response.setHeader('Connection','close');
          if (error instanceof CalendarError || error instanceof WriteRequestError) privateJson(response,error.status,{error:error.message});
          else if (error instanceof RevisionConflictError) privateJson(response,409,{error:'任务清单已更新，请重试。'});
          else privateJson(response,503,{error:'本机日历暂时不可用。'});
        }
        return;
      }
      if (['/api/v1/focus-review', '/api/v1/focus-review/experiment', '/api/v1/focus-review/synthesis'].includes(pathname)) {
        await reviewHttp(request, response);
        return;
      }
      if (pathname === '/api/v1/project-progress') { await projects.handle(request, response); return; }
      if (pathname === '/api/v1/recorder') { await recorderHttp(request, response); return; }
      if (pathname === '/api/v1/screen-observation') { await screenObservation.handle(request, response); return; }
      if (pathname === '/api/v1/checkpoints') { await checkpointHttp(request, response); return; }
      if (pathname === UPDATE_PATH || pathname === FOCUS_PATH || pathname === WORK_STATE_PATH || pathname === AI_SUGGESTION_PATH) {
        const focus = pathname === FOCUS_PATH;
        const workState = pathname === WORK_STATE_PATH;
        const aiSuggestion = pathname === AI_SUGGESTION_PATH;
        if (request.method !== 'PUT') {
          response.setHeader('Allow', 'PUT');
          json(response, 405, 'METHOD_NOT_ALLOWED', 'Only PUT is supported for updates.', head);
          return;
        }
        try {
          checkWritePolicy(request.socket.remoteAddress, request.headers.host, request.headers.origin, request.headers['content-type']);
          const body = await readUpdateBody(request, writeTimeoutMs);
          let overview;
          let cause: 'start' | 'stop' | 'snapshot' = 'snapshot';
          if (aiSuggestion) overview = await loader.updateAISuggestion(parseAISuggestionUpdateText(body));
          else if (workState) overview = await loader.updateWorkState(parseWorkStateUpdateText(body));
          else if (focus) {
            const input = parseFocusUpdateText(body);
            cause = input.action;
            overview = await loader.updateFocus(input);
          }
          else overview = await loader.update(parseTaskUpdateText(body));
          await observe(overview, cause);
          send(response, 200, JSON.stringify(overview), 'application/json; charset=utf-8', false);
        } catch (error) {
          // Rejected uploads need not be drained; close after the error so an
          // unfinished/oversized request cannot hold a keep-alive connection.
          response.setHeader('Connection', 'close');
          if (error instanceof WriteRequestError) json(response, error.status, error.code, error.message, false);
          else if (error instanceof CalendarError) json(response, error.status, 'CALENDAR_CONFLICT', error.message, false);
          else if (error instanceof OverviewValidationError) json(response, 400, aiSuggestion ? 'INVALID_AI_SUGGESTION' : workState ? 'INVALID_WORK_STATE_UPDATE' : focus ? 'INVALID_FOCUS_UPDATE' : 'INVALID_TASK_UPDATE', error.message, false);
          else if (error instanceof FocusActiveError) json(response, 409, 'FOCUS_ALREADY_ACTIVE', error.message, false);
          else if (error instanceof RevisionConflictError) json(response, 409, 'REVISION_CONFLICT', error.message, false);
          else if (error instanceof SourceError) json(response, 503, error.code, error.message, false);
          else json(response, 500, 'INTERNAL_ERROR', 'Tasks could not be saved.', false);
        }
        return;
      }
      if (request.method !== 'GET' && !head) {
        response.setHeader('Allow', 'GET, HEAD');
        json(response, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported.', head);
        return;
      }
      if (pathname === '/api/v1/server-info') {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Server not listening on TCP');
        send(response, 200, JSON.stringify(getServerInfo(address.address, address.port)), 'application/json; charset=utf-8', head);
        return;
      }
      if (pathname === '/connect') {
        send(response, 200, await readFile(CONNECT_PAGE), 'text/html; charset=utf-8', head);
        return;
      }
      if (pathname === API_PATH || pathname === DISPLAY_PATH) {
        try {
          const overview = await loader.load();
          await observe(overview);
          let payload;
          if (pathname === DISPLAY_PATH) {
            const project = await projects.pinned(overview);
            if (project) {
              const snapshot = buildProjectDisplay(project, '');
              // Reading positions may change while all visible device pixels remain the same.
              snapshot.revision = 'project:' + createHash('sha256')
                .update(snapshot.layout_version).update(JSON.stringify(snapshot.commands)).digest('hex');
              payload = snapshot;
            } else payload = buildDisplaySnapshot(overview);
          } else {
            const view = new URLSearchParams(request.url?.split('?')[1]).get('view');
            const legacyDevice = view === 'device' || (view !== 'workspace' && !isLoopback(request.socket.remoteAddress));
            payload = legacyDevice ? deviceOverview(overview) : overview;
          }
          const body = JSON.stringify(payload);
          if (Buffer.byteLength(body) > MAX_OVERVIEW_BYTES) throw new SourceError('DISPLAY_SNAPSHOT_TOO_LARGE', 'Display snapshot exceeds the response limit.');
          send(response, 200, body, 'application/json; charset=utf-8', head);
        } catch (error) {
          if (error instanceof CalendarError) json(response, error.status, 'CALENDAR_UNAVAILABLE', error.message, head);
          else if (error instanceof SourceError) json(response, 503, error.code, error.message, head);
          else json(response, 500, 'INTERNAL_ERROR', 'Overview could not be produced.', head);
        }
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        json(response, 404, 'NOT_FOUND', 'API endpoint not found.', head);
        return;
      }
      const appPage = pathname === '/' || pathname === '/simulator' || pathname === '/simulator/';
      const target = path.resolve(root, appPage ? 'index.html' : `.${pathname}`);
      const type = mime[path.extname(target).toLowerCase()];
      if (!within(root, target) || !type) {
        json(response, 404, 'NOT_FOUND', 'Static resource not found.', head);
        return;
      }
      try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        if (!within(realRoot, realTarget) || !(await stat(realTarget)).isFile()) {
          json(response, 403, 'FORBIDDEN_PATH', 'Path is not available.', head);
          return;
        }
        send(response, 200, await readFile(realTarget), type, head);
      } catch {
        json(response, 404, 'STATIC_NOT_FOUND', 'Build the Dashboard first or check the requested resource.', head);
      }
    } catch {
      if (!response.headersSent) json(response, 500, 'INTERNAL_ERROR', 'Request could not be completed.', head);
      else response.destroy();
    }
  });
  server.once('close', () => void recorder.close());
  return Object.assign(server, { stopRecording: recorder.close });
}
