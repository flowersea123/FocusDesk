import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DailyOverview } from '../../contracts/daily-overview.ts';
import { createDailySynthesis } from './daily-synthesis.ts';
import { ReviewInputError, createFocusReview } from './focus-review.ts';
import { privateJson, privateInput, checkPrivateRequest } from './checkpoint-http.ts';
import { CheckpointError, createCheckpointStore } from './checkpoint-store.ts';
import { WriteRequestError } from './write-policy.ts';

export function createReviewHttp(
  reviews: ReturnType<typeof createFocusReview>,
  checkpoints: ReturnType<typeof createCheckpointStore>,
  load: () => Promise<DailyOverview>,
) {
  const synthesize = createDailySynthesis();
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      checkPrivateRequest(request);
      const url = new URL(request.url!, 'http://localhost');
      const experiment = url.pathname === '/api/v1/focus-review/experiment';
      const synthesis = url.pathname === '/api/v1/focus-review/synthesis';
      const expected = experiment ? 'PUT' : synthesis ? 'POST' : 'GET';
      if (request.method !== expected) {
        response.setHeader('Allow', expected);
        privateJson(response, 405, { error: '不支持此操作。' });
        return;
      }

      const overview = await load();
      await reviews.observe(overview);
      let date = url.searchParams.get('date') ?? undefined;
      if (experiment || synthesis) {
        const input = await privateInput(request);
        if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          throw new CheckpointError(400, '请选择有效日期。');
        }
        date = input.date;
        if (experiment) {
          await reviews.setExperiment(input);
          privateJson(response, 200, { saved: true });
          return;
        }
      }

      const { records } = await checkpoints.read();
      const observations = records.map(r => ({ id: r.id, at: r.capturedAt, summary: r.summary, nextStep: r.nextStep, source: r.source, appName: r.appName, taskId: r.taskId }));
      const result = await reviews.read(date, overview.timezone, observations);
      privateJson(response, 200, synthesis ? await synthesize(result) : result);
    } catch (error) {
      if (error instanceof ReviewInputError || error instanceof CheckpointError || error instanceof WriteRequestError) {
        privateJson(response, error.status, { error: error.message });
      } else privateJson(response, 503, { error: '本机每日回顾暂时不可用，请稍后重试。' });
    }
  };
}
