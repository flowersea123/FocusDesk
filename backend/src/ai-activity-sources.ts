import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { privateJson } from './checkpoint-http.ts';
import { isLocalRequest, readUpdateBody, WriteRequestError } from './write-policy.ts';
import type { AiActivitySource, AiRunObservation } from './ai-activity-types.ts';
import { createCodexActivitySource } from './codex-activity.ts';

// The bundled extension's public manifest key gives it the same origin in Chrome and Edge.
export const BROWSER_ACTIVITY_ORIGIN = 'chrome-extension://ekcleglehkhodjnllfkbahkijbghdfjd';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const browserFreshMs = 35_000;

export function createAiActivitySources({ now = Date.now, codex = createCodexActivitySource }: {
  now?: () => number; codex?: () => AiActivitySource;
} = {}) {
  let session: string | null = null;
  const active = new Map<string, AiRunObservation>();
  let edges: AiRunObservation[] = [];
  function reset() { active.clear(); edges = []; session = null; }
  function expire() {
    const cutoff = now() - browserFreshMs;
    for (const [id, last] of active) if (last.at < cutoff) {
      active.delete(id);
      edges.push({ ...last, state: 'interrupted' });
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (!isLocalRequest(req.socket.remoteAddress, req.headers.host) || req.headers.origin !== BROWSER_ACTIVITY_ORIGIN) {
        privateJson(res, 403, {error: '仅限本机 FocusDesk 浏览器扩展。'}); return;
      }
      res.setHeader('Access-Control-Allow-Origin', BROWSER_ACTIVITY_ORIGIN);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return;
      }
      if (req.method !== 'POST') { privateJson(res, 405, {error:'请使用 POST。'}); return; }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { privateJson(res,415,{}); return; }
      const input = JSON.parse(await readUpdateBody(req, 3000, 512));
      if (!input || typeof input !== 'object' || Array.isArray(input)) { privateJson(res,400,{}); return; }
      if (input.action === 'status' && Object.keys(input).length === 1) { privateJson(res,200,{session}); return; }
      if (Object.keys(input).length !== 3 || typeof input.id !== 'string' || !uuid.test(input.id) ||
          !['running','finished','interrupted'].includes(input.action)) { privateJson(res,400,{}); return; }
      if (!session || input.session !== session) { privateJson(res,409,{session:null}); return; }
      expire();
      const key = 'chatgpt-' + input.id, previous = active.get(key);
      const event: AiRunObservation = { runId:key, appName:'ChatGPT', title:'网页生成 ' + input.id.slice(0,4),
        at:now(), state:input.action };
      if (input.action === 'running') {
        if (!previous && (active.size >= 128 || edges.length >= 256)) { privateJson(res,429,{}); return; }
        if (!previous) edges.push(event);
        active.set(key,event);
      } else if (previous) {
        // A tab disappearing only confirms activity through its last positive observation.
        edges.push(input.action === 'interrupted' ? { ...previous, state:'interrupted' } : event);
        active.delete(key);
      }
      privateJson(res,200,{session});
    } catch (error) {
      privateJson(res,error instanceof WriteRequestError ? error.status : 400,{error:'浏览器状态请求无效。'});
    }
  }
  function open(recording: AbortSignal): AiActivitySource {
    reset();
    const token = session = randomUUID();
    const desktop = codex();
    const stop = () => { if (session === token) reset(); };
    if (recording.aborted) stop();
    else recording.addEventListener('abort', stop, {once:true});
    return {
      async poll(signal) {
        if (signal.aborted || session !== token) return [];
        let turns: AiRunObservation[] = [];
        try { turns = await desktop.poll(signal); } catch { /* The browser source remains available independently. */ }
        if (signal.aborted || session !== token) return [];
        expire();
        const observed = [...turns, ...edges, ...active.values()];
        edges = [];
        return observed;
      },
      async close() { recording.removeEventListener('abort', stop); stop(); await desktop.close?.(); },
    };
  }
  return { open, handle };
}
