import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkPrivateRequest, privateInput, privateJson } from './checkpoint-http.ts';
import { WriteRequestError } from './write-policy.ts';
import type { createForegroundRecorder } from './foreground-recorder.ts';

export function createRecorderHttp(recorder: ReturnType<typeof createForegroundRecorder>, pendingTask: (id: string) => Promise<boolean>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      checkPrivateRequest(request);
      if (request.method === 'GET') {
        privateJson(response, 200, await recorder.readStatus());
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        privateJson(response, 405, { error: '请通过本机任务页控制屏幕记录。' });
        return;
      }
      const input = await privateInput(request);
      const { action, taskId } = input;
      if (Object.keys(input).some(key => key !== 'action' && key !== 'taskId') || !['start', 'start-ai', 'stop', 'target'].includes(action) ||
          ((action === 'stop' || action === 'start-ai') && taskId !== undefined) || (action === 'target' && taskId === undefined) ||
          (taskId != null && (typeof taskId !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(taskId)))) {
        privateJson(response, 400, { error: '请使用有效的录制操作和任务编号。' });
        return;
      }
      if (taskId && !await pendingTask(taskId)) throw new WriteRequestError(409, 'TASK_CHANGED', '此任务已结束或移除，请选择其他待办。');
      const status = action === 'target' ? recorder.target(taskId) : action === 'stop' ? recorder.stop() :
        recorder.start(taskId, action === 'start-ai' ? 'ai' : 'screen');
      privateJson(response, 200, status);
    } catch (error) {
      response.setHeader('Connection', 'close');
      if (error instanceof WriteRequestError) privateJson(response, error.status, { error: error.message });
      else privateJson(response, 503, { error: '暂时无法连接本机记录服务。' });
    }
  };
}
