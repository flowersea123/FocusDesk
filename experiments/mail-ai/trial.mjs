import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MAX_EML_BYTES, readEmlBytes } from './mail-source.mjs';
import { analyzeMail, beijingMinute, localOrigin } from './analyze.mjs';
import { assessMail } from './assess.mjs';
import { calendarDeadline, planChoices, planRevision, readCalendar, saveMailPlan, selectedPlan } from './mail-calendar.mjs';

const pageTemplate = await readFile(new URL('./trial.html', import.meta.url), 'utf8');
const outlookScript = await readFile(new URL('./outlook-ui.js', import.meta.url), 'utf8');
const planScript = await readFile(new URL('./mail-plan-ui.js', import.meta.url), 'utf8');
const tenMinutes = 10 * 60 * 1000;

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(request, expectedType, limit) {
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== expectedType) throw new RequestError(415, '上传格式有误，请重新选择邮件。');
  if (Number(request.headers['content-length']) > limit) throw new RequestError(413, '上传内容超过大小上限。');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw new RequestError(413, '上传内容超过大小上限。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function sampleEml(now) {
  const date = beijingMinute(new Date(now + 2 * 86_400_000).toISOString()).slice(0, 10);
  return Buffer.from([
    'From: Design Course <studio@example.org>', 'To: Student <student@example.org>',
    'Date: ' + new Date(now).toUTCString(), `Message-ID: <focusdesk-demo-${date}@example.org>`,
    'Subject: Design portfolio deadline', 'Content-Type: text/plain; charset=UTF-8', '',
    `Please submit the design portfolio by ${date} 17:00 Beijing time.`,
  ].join('\r\n'));
}

export function createTrialServer({ outlook, analyze = analyzeMail, save = saveMailPlan, calendar = readCalendar, now = Date.now,
  hub = process.env.FOCUSDESK_HUB_URL ?? 'http://127.0.0.1:8787',
  endpoint = process.env.FOCUSDESK_MODEL_URL, model = process.env.FOCUSDESK_MODEL_NAME,
  canvasOrigin = process.env.FOCUSDESK_CANVAS_ORIGIN } = {}) {
  const hubOrigin = localOrigin(hub);
  const tickets = new Map();
  let analyzing = false;

  function discardExpired() {
    for (const [id, entry] of tickets) if (entry.expires <= now()) tickets.delete(id);
  }
  async function preview(candidates, mail) {
    discardExpired();
    const choices = planChoices({ ...mail, actions: candidates.map(candidate => ({ ...candidate,
      verified: !candidate.reason, status: candidate.reason ? 'review' : 'pending' })) });
    let calendarData;
    try { calendarData = await calendar(hubOrigin); } catch { /* The preview also works with the Hub offline. */ }
    const compact = text => text.trim().replace(/\s+/g, ' ');
    const body = compact(mail.body);
    const today = beijingMinute(new Date(now()).toISOString()).slice(0, 10);
    const items = choices.map((choice, index) => {
      const candidate = candidates[index];
      const expired = choice.dueAt ? Date.parse(choice.dueAt) <= now() : choice.dueDate && choice.dueDate < today;
      const eligible = Boolean(choice.dueDate && !expired && !candidate?.reason);
      const ticket = randomUUID();
      if (tickets.size >= 64) tickets.delete(tickets.keys().next().value);
      tickets.set(ticket, { choice, eligible, expires: now() + tenMinutes });
      const { sourceKey, ...publicChoice } = choice;
      const entry = calendarData?.entries.find(entry => entry.id === choice.id) ?? null;
      return { ...publicChoice, dueDate: calendarDeadline(choice, calendarData?.timezone), entry, planRevision: planRevision(entry), planTicket: ticket,
        ticket: eligible ? ticket : null, actionTitle: candidate?.title, quote: candidate?.quote, source: candidate?.source,
        quoteInBody: Boolean(candidate && body.includes(compact(candidate.quote))),
        time: choice.dueAt ? beijingMinute(choice.dueAt) : choice.dueDate ? null : candidate?.due_local || null,
        reason: candidate?.reason || (expired ? '截止时间已过' : null) };
    });
    return { candidates: candidates.length ? items : [], mailPlan: candidates.length ? null : items[0] };
  }

  const server = createServer({ requestTimeout: 25_000, headersTimeout: 12_000, connectionsCheckingInterval: 5_000 }, async (request, response) => {
    const { method, url, headers, socket } = request;
    const origin = `http://${headers.host}`;
    const port = server.address().port;
    const localHosts = [new URL(`http://127.0.0.1:${port}`).host, new URL(`http://localhost:${port}`).host];
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (socket.remoteAddress !== '127.0.0.1' || !localHosts.includes(headers.host)) throw new RequestError(403, '请从本机试读页打开。');
      if (method === 'GET' && (url === '/outlook-ui.js' || url === '/mail-plan-ui.js')) {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(url === '/outlook-ui.js' ? outlookScript : planScript);
        return;
      }
      if (method === 'GET' && url === '/') {
        const nonce = randomUUID();
        response.setHeader('Content-Security-Policy', `default-src 'none'; connect-src 'self'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(pageTemplate.replaceAll('{{NONCE}}', nonce).replace('{{HUB}}', hubOrigin));
        return;
      }
      const parsed = new URL(url, origin);
      if (outlook && method === 'GET' && parsed.pathname === '/auth/callback') {
        // Exchange the one-use code on this machine. Redirect to a clean URL even on failure.
        let notice = 'connected';
        try { await outlook.finish(parsed.searchParams); }
        catch (error) { notice = 'error=' + encodeURIComponent(error.message.slice(0, 300)); }
        response.writeHead(303, { Location: '/#outlook-' + notice });
        response.end();
        return;
      }
      if (outlook && method === 'GET' && parsed.pathname === '/api/outlook/status') {
        const limit = Number(parsed.searchParams.get('limit') || 60);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new RequestError(400, '历史条数无效。');
        response.end(JSON.stringify(await outlook.status(limit)));
        return;
      }
      if (outlook && method === 'POST' && ['/api/outlook/connect', '/api/outlook/disconnect', '/api/outlook/sync', '/api/outlook/plan'].includes(url)) {
        if (headers.origin !== origin) throw new RequestError(403, '请从本机同一试读页操作。');
        let input;
        try { input = JSON.parse((await readBody(request, 'application/json', 4096)).toString('utf8')); }
        catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(400, '请检查邮箱配置。'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, '请检查邮箱配置。');
        if (url.endsWith('/plan')) {
          response.end(JSON.stringify(await outlook.plan(input)));
        } else if (url.endsWith('/connect')) {
          const settings = {};
          for (const key of ['clientId', 'tenantId', 'accountType']) {
            if (input[key] !== undefined) {
              if (typeof input[key] !== 'string') throw new RequestError(400, '应用标识格式有误。');
              settings[key] = input[key].trim();
            }
          }
          const { authorizationUrl } = await outlook.begin(settings);
          response.end(JSON.stringify({ authorizationUrl }));
        } else {
          if (url.endsWith('/sync')) await outlook.sync();
          else await outlook.disconnect();
          response.end('{}');
        }
        return;
      }
      if (method !== 'POST' || !['/api/sample','/api/eml','/api/import'].includes(url)) throw new RequestError(404, '未找到此页面。');
      if (headers.origin !== origin) throw new RequestError(403, '请从本机同一试读页操作。');
      if (url === '/api/import') {
        let data;
        const text = (await readBody(request, 'application/json', 4096)).toString('utf8');
        try { data = JSON.parse(text); } catch { throw new RequestError(400, '待办选择格式有误。'); }
        const allowed = ['ticket', 'plannedDate', 'dueDate', 'title', 'deviceTitle', 'expectedRevision', 'restore'];
        if (!data || typeof data.ticket !== 'string' || Object.keys(data).some(key => !allowed.includes(key)) ||
            (!data.plannedDate && Object.keys(data).length !== 1)) throw new RequestError(400, '请选择预览中的待办和计划日。');
        discardExpired();
        const ticket = tickets.get(data.ticket);
        if (!ticket) throw new RequestError(410, '这次预览已失效，请重新读取邮件。');
        if (!data.plannedDate && (!ticket.eligible || ticket.choice.dueAt && Date.parse(ticket.choice.dueAt) <= now())) throw new RequestError(409, '请明确选择计划日。');
        const entry = selectedPlan(ticket.choice, { ...data, plannedDate: data.plannedDate || ticket.choice.dueDate });
        const result = await save({ ...entry, hub: hubOrigin });
        response.end(JSON.stringify(result));
        return;
      }
      if (analyzing) throw new RequestError(429, '正在读取另一封邮件，请稍后再试。');
      analyzing = true;
      try {
        // Both buttons submit MIME; the sample button sends an empty body.
        const bytes = await readBody(request, 'message/rfc822', url === '/api/eml' ? MAX_EML_BYTES : 0);
        const mail = await readEmlBytes(url === '/api/sample' ? sampleEml(now()) : bytes);
        let result, analysisError;
        try { result = await analyze(mail, { endpoint, model }); }
        catch { result = { summary: '', deadlines: [] }; analysisError = '本机模型暂时无法分析，可直接安排这封邮件。'; }
        const planning = await preview(assessMail(mail, result, { canvasOrigin }), mail);
        const images = mail.images.map(img => 'data:' + img.mime + ';base64,' + img.data.toString('base64'));
        response.end(JSON.stringify({ subject: mail.subject, body: mail.body, summary: result.summary, analysisError, ...planning, images }));
      } finally { analyzing = false; }
    } catch (error) {
      response.statusCode = error instanceof RequestError || error.status === 409 ? error.status : 422;
      response.setHeader('Connection', 'close');
      response.end(JSON.stringify({ error: error instanceof SyntaxError ? '无法读取模型或邮件的内容，请重试。' : error.message, ...(error.planRevision ? { current: error.current, planRevision: error.planRevision } : {}) }));
    }
  });
  const sweep = setInterval(discardExpired, 60_000).unref();
  server.once('close', () => { clearInterval(sweep); tickets.clear(); });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.FOCUSDESK_TRIAL_PORT ?? 5184);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('试读页端口应为 1 至 65535。');
  const { openOutlookService } = await import('./outlook-service.mjs');
  const outlook = await openOutlookService({ port, hub: process.env.FOCUSDESK_HUB_URL ?? 'http://127.0.0.1:8787',
    endpoint: process.env.FOCUSDESK_MODEL_URL, model: process.env.FOCUSDESK_MODEL_NAME,
    canvasOrigin: process.env.FOCUSDESK_CANVAS_ORIGIN });
  const server = createTrialServer({ outlook });
  server.once('error', async error => { console.error(error.message); process.exitCode = 1; await outlook.close(); });
  server.listen(port, '127.0.0.1', () => console.log(`FocusDesk 邮件服务 http://127.0.0.1:${port}/`));
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    await outlook.close();
  }
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
