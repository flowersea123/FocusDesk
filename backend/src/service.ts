import { createServer, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createOverviewLoader, FocusActiveError, RevisionConflictError, SourceError } from './overview-loader.ts';
import { MAX_OVERVIEW_BYTES, OverviewValidationError } from '../../contracts/daily-overview.ts';
import { parseTaskUpdateText } from '../../contracts/task-update.ts';
import { parseFocusUpdateText } from '../../contracts/focus-update.ts';
import { parseWorkStateUpdateText } from '../../contracts/work-state.ts';
import { parseAISuggestionUpdateText } from '../../contracts/ai-suggestion.ts';
import { buildDisplaySnapshot } from '../../contracts/display-snapshot.ts';
import { checkWritePolicy, readUpdateBody, WriteRequestError } from './write-policy.ts';
import { getServerInfo } from './network-info.ts';
import { fileURLToPath } from 'node:url';

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
  '.woff': 'font/woff', '.woff2': 'font/woff2',
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

export function createDemoServer({ dataPath, distPath, writeTimeoutMs = 5_000, now, loader: sharedLoader }: { dataPath: string; distPath: string; writeTimeoutMs?: number; now?: () => number; loader?: ReturnType<typeof createOverviewLoader> }) {
  const loader = sharedLoader ?? createOverviewLoader(dataPath, { now });
  const root = path.resolve(distPath);
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
          if (aiSuggestion) overview = await loader.updateAISuggestion(parseAISuggestionUpdateText(body));
          else if (workState) overview = await loader.updateWorkState(parseWorkStateUpdateText(body));
          else if (focus) overview = await loader.updateFocus(parseFocusUpdateText(body));
          else overview = await loader.update(parseTaskUpdateText(body));
          send(response, 200, JSON.stringify(overview), 'application/json; charset=utf-8', false);
        } catch (error) {
          // Rejected uploads need not be drained; close after the error so an
          // unfinished/oversized request cannot hold a keep-alive connection.
          response.setHeader('Connection', 'close');
          if (error instanceof WriteRequestError) json(response, error.status, error.code, error.message, false);
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
          const body = JSON.stringify(pathname === DISPLAY_PATH ? buildDisplaySnapshot(overview) : overview);
          if (Buffer.byteLength(body) > MAX_OVERVIEW_BYTES) throw new SourceError('DISPLAY_SNAPSHOT_TOO_LARGE', 'Display snapshot exceeds the response limit.');
          send(response, 200, body, 'application/json; charset=utf-8', head);
        } catch (error) {
          if (error instanceof SourceError) json(response, 503, error.code, error.message, head);
          else json(response, 500, 'INTERNAL_ERROR', 'Overview could not be produced.', head);
        }
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        json(response, 404, 'NOT_FOUND', 'API endpoint not found.', head);
        return;
      }
      const target = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
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
  return server;
}
