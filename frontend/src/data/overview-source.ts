import {
  MAX_OVERVIEW_BYTES,
  parseDailyOverview,
  parseDailyOverviewText,
  type DailyOverview,
} from '../../../contracts/daily-overview';
import { parseTaskUpdateRequest, type TaskUpdateRequest } from '../../../contracts/task-update';
import { parseFocusUpdateRequest, type FocusUpdateRequest } from '../../../contracts/focus-update';
import { parseWorkStateUpdateRequest, type WorkStateUpdateRequest } from '../../../contracts/work-state';
import { parseAISuggestionUpdateRequest, type AISuggestionUpdateRequest } from '../../../contracts/ai-suggestion';
import today from '../../../contracts/fixtures/today.json';
import empty from '../../../contracts/fixtures/empty.json';
import completed from '../../../contracts/fixtures/completed.json';
import nextDay from '../../../contracts/fixtures/next-day.json';

export type DemoScenario = 'today' | 'empty' | 'completed' | 'next-day' | 'failure';
export interface OverviewSource {
  kind: 'mock' | 'http';
  localWorkspace?: boolean;
  read(scenario: DemoScenario, signal: AbortSignal): Promise<DailyOverview>;
  updateTasks?(input: TaskUpdateRequest, signal: AbortSignal): Promise<DailyOverview>;
  updateFocus?(input: FocusUpdateRequest, signal: AbortSignal): Promise<DailyOverview>;
  updateWorkState?(input: WorkStateUpdateRequest, signal: AbortSignal): Promise<DailyOverview>;
  updateAISuggestion?(input: AISuggestionUpdateRequest, signal: AbortSignal): Promise<DailyOverview>;
}

export function createMockSource(delayMs = 220): OverviewSource {
  const fixtures = { today, empty, completed, 'next-day': nextDay };
  return {
    kind: 'mock',
    async read(scenario, signal) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
        signal.addEventListener('abort', abort, { once: true });
      });
      if (scenario === 'failure') throw new Error('这是模拟的读取失败。切换样例或重试即可恢复。');
      return parseDailyOverview(fixtures[scenario]);
    },
  };
}

interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  pageOrigin?: string;
}

export class OverviewRequestError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = '') {
    super(message); this.name = 'OverviewRequestError'; this.status = status; this.code = code;
  }
}

export function createHttpSource({ baseUrl, timeoutMs = 5_000, fetcher = fetch,
  pageOrigin = typeof window === 'undefined' ? undefined : window.location.origin,
}: HttpOptions): OverviewSource {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/daily-overview`;
  let canWrite = false;
  try {
    if (pageOrigin) {
      const page = new URL(pageOrigin);
      const hostname = page.hostname.replace(/^\[|\]$/g, '');
      canWrite = page.protocol === 'http:' && (hostname === 'localhost' || hostname === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hostname)) &&
        new URL(endpoint, pageOrigin).origin === pageOrigin;
    }
  } catch { /* Invalid or remote origins remain read-only. */ }
  async function request(url: string, signal: AbortSignal, body?: string): Promise<DailyOverview> {
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        controller.signal.throwIfAborted();
        const response = await fetcher(url, {
          signal: controller.signal, cache: 'no-store',
          headers: body === undefined ? { Accept: 'application/json' } :
            { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
          ...(body === undefined ? {} : { method: 'PUT', body }),
        });
        const declaredLength = Number(response.headers.get('content-length'));
        if (declaredLength > MAX_OVERVIEW_BYTES) {
          await response.body?.cancel();
          throw new Error('响应超过 4 KiB，已拒绝读取。');
        }
        if (!response.body) throw new Error('服务未返回可读取的内容。');
        const reader = response.body.getReader();
        const abortRead = () => { void reader.cancel().catch(() => undefined); };
        controller.signal.addEventListener('abort', abortRead, { once: true });
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        let text = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_OVERVIEW_BYTES) {
              await reader.cancel();
              throw new Error('响应超过 4 KiB，已拒绝读取。');
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          controller.signal.removeEventListener('abort', abortRead);
          reader.releaseLock();
        }
        if (!response.ok) {
          let message = `服务请求失败（HTTP ${response.status}）。`;
          let code = '';
          try {
            const failure = JSON.parse(text).error;
            if (typeof failure?.message === 'string') message = failure.message.slice(0, 400);
            if (typeof failure?.code === 'string') code = failure.code.slice(0, 64);
          } catch { /* Non-JSON failures still preserve their HTTP status. */ }
          throw new OverviewRequestError(message, response.status, code);
        }
        return parseDailyOverviewText(text);
      } catch (error) {
        if (timedOut) throw new Error('读取超时，请检查服务后重试。');
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      }
  }
  return {
    kind: 'http',
    localWorkspace: canWrite && new URL(endpoint, pageOrigin).pathname === '/api/v1/daily-overview',
    read(_scenario, signal) { return request(endpoint, signal); },
    ...(canWrite ? {
      updateTasks(input: TaskUpdateRequest, signal: AbortSignal) {
        return request(`${endpoint}/tasks`, signal, JSON.stringify(parseTaskUpdateRequest(input)));
      },
      updateFocus(input: FocusUpdateRequest, signal: AbortSignal) {
        return request(`${endpoint}/focus`, signal, JSON.stringify(parseFocusUpdateRequest(input)));
      },
      updateWorkState(input: WorkStateUpdateRequest, signal: AbortSignal) {
        return request(`${endpoint}/work-state`, signal, JSON.stringify(parseWorkStateUpdateRequest(input)));
      },
      updateAISuggestion(input: AISuggestionUpdateRequest, signal: AbortSignal) {
        return request(`${endpoint}/ai-suggestion`, signal, JSON.stringify(parseAISuggestionUpdateRequest(input)));
      },
    } : {}),
  };
}

export function createConfiguredSource(): OverviewSource {
  const kind = import.meta.env.VITE_DATA_SOURCE ?? (import.meta.env.DEV ? 'mock' : 'http');
  return kind === 'http'
    ? createHttpSource({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '' })
    : createMockSource();
}
