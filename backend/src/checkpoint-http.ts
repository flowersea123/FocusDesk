import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLocalRequest, checkWritePolicy, readUpdateBody, WriteRequestError } from './write-policy.ts';
import { CheckpointError, createCheckpointStore } from './checkpoint-store.ts';
import type { DailyOverview } from '../../contracts/daily-overview.ts';

export function privateJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export function checkPrivateRequest(request: IncomingMessage) {
  const { origin, host } = request.headers;
  if (!isLocalRequest(request.socket.remoteAddress, host) || (origin && origin !== 'http://' + host) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new WriteRequestError(403, 'LOCAL_ONLY', '请在本机 FocusDesk 面板打开。');
  }
}
export async function privateInput(request: IncomingMessage) {
  checkWritePolicy(request.socket.remoteAddress, request.headers.host, request.headers.origin, request.headers['content-type']);
  let input;
  try { input = JSON.parse(await readUpdateBody(request, 8_000, 16 * 1024)); }
  catch (error) {
    if (error instanceof WriteRequestError) throw error;
    throw new WriteRequestError(400, 'INVALID_JSON', '请求格式无效。');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WriteRequestError(400, 'INVALID_JSON', '请求格式无效。');
  return input;
}
export function createCheckpointHttp(store: ReturnType<typeof createCheckpointStore>, load: () => Promise<DailyOverview>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      checkPrivateRequest(request);
      if (request.method === 'GET') {
        const state = await store.read();
        privateJson(response, 200, { records: state.records.slice(-12).reverse() });
        return;
      }
      if (!['POST','PATCH','DELETE'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, POST, PATCH, DELETE'); privateJson(response, 405, { error: '不支持此操作。' }); return; }
      const input = await privateInput(request);
      if (request.method === 'DELETE') await store.remove(input.id);
      else if (request.method === 'PATCH') await store.confirmReading(input.id, input.readingSection);
      else {
        if (input.taskId && !(await load()).tasks.some(t => t.id === input.taskId)) throw new CheckpointError(409, '所选任务已移除，请重新选择。');
        await store.add(input);
      }
      privateJson(response, 200, { saved: true });
    } catch (error) {
      response.setHeader('Connection', 'close');
      if (error instanceof CheckpointError || error instanceof WriteRequestError) privateJson(response, error.status, { error: error.message });
      else privateJson(response, 503, { error: '本机记录暂时不可用，请稍后重试。' });
    }
  };
}
