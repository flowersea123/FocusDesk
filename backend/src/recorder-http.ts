import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkPrivateRequest, privateInput, privateJson } from './checkpoint-http.ts';
import { WriteRequestError } from './write-policy.ts';
import type { createForegroundRecorder } from './foreground-recorder.ts';

export function createRecorderHttp(recorder: ReturnType<typeof createForegroundRecorder>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      checkPrivateRequest(request);
      if (request.method === 'GET') {
        privateJson(response, 200, await recorder.readStatus());
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        privateJson(response, 405, { error: '请通过本机记录页开始或停止。' });
        return;
      }
      const input = await privateInput(request);
      if (Object.keys(input).length !== 1 || !['start', 'stop'].includes(input.action)) {
        privateJson(response, 400, { error: '请选择开始或停止记录。' });
        return;
      }
      privateJson(response, 200, input.action === 'start' ? recorder.start() : recorder.stop());
    } catch (error) {
      response.setHeader('Connection', 'close');
      if (error instanceof WriteRequestError) privateJson(response, error.status, { error: error.message });
      else privateJson(response, 503, { error: '暂时无法连接本机记录服务。' });
    }
  };
}
