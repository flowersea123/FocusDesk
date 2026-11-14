import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDemoServer } from '../../../backend/src/service.ts';
import { analyzeMail } from '../analyze.mjs';
import { readOutlookDeltaMail, readOutlookDeltaPage } from '../outlook-delta.mjs';
import { outlookController } from '../outlook-service.mjs';
import { createOutlookWorker } from '../outlook-worker.mjs';
import { createTrialServer } from '../trial.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
function close(server) {
  return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

test('a local login callback starts a durable Inbox subscription and writes an actual Hub task exactly once', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-outlook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  const now = Date.parse('2026-11-14T01:00:00Z');
  await writeFile(file, JSON.stringify({ date: '2026-11-14', timezone: 'Asia/Shanghai', tasks: [] }));
  const hub = createDemoServer({ dataPath: file, distPath: dir, now: () => now });
  const hubOrigin = await listen(hub);
  t.after(() => close(hub));
  const eml = await readFile(new URL('../evaluation/portfolio.eml', import.meta.url));
  const folder = 'folder-id';
  const delta = 'https://graph.microsoft.com/v1.0/me/mailFolders/' + folder + '/messages/delta';
  let connected = false, requestedMime = 0, inference = 0;
  const authorizationUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
  const settings = { accountType: 'personal', clientId: 'test-client' };
  const auth = {
    status: async () => ({ connected, configured: true, ...settings, redirectUri: 'http://localhost:5184/auth/callback' }),
    begin: async input => { assert.deepEqual(input, settings); return { authorizationUrl }; },
    finish: async params => { assert.equal(params.get('code'), 'synthetic'); connected = true; },
    disconnect: async () => { connected = false; },
  };
  async function graph(href) {
    const u = new URL(href);
    if (u.pathname.endsWith('/inbox')) return Response.json({ id: folder });
    if (u.pathname.endsWith('/delta')) return Response.json({
      value: [{ id: 'old', receivedDateTime: '2026-10-01T00:00:00Z' }, { id: 'new', receivedDateTime: '2026-11-14T01:02:00Z' }],
      '@odata.deltaLink': delta + '?$deltatoken=fixture',
    });
    assert.match(u.pathname, /\/new\/\$value$/);
    requestedMime++;
    return new Response(eml);
  }
  const worker = createOutlookWorker({
    stateDir: dir, getSession: async () => connected ? { accountId: 'personal:user', accessToken: 'mock', connectedAt: new Date(now).toISOString() } : null,
    now: () => now, hub: hubOrigin, readPage: opts => readOutlookDeltaPage({ ...opts, fetcher: graph }),
    readMail: opts => readOutlookDeltaMail({ ...opts, fetcher: graph }), analyze: async mail => {
      inference++;
      if (process.env.FOCUSDESK_TEST_LIVE_MODEL === '1') return analyzeMail(mail);
      return { summary: '提交设计作品集。', deadlines: [{ title: 'Submit portfolio', source: 'body', quote: mail.body, due_local: '2026-11-16 17:00' }] };
    },
  });
  const service = outlookController(auth, worker);
  const trial = createTrialServer({ outlook: service });
  const origin = await listen(trial);
  t.after(async () => { await worker.stop(); await close(trial); });
  const post = (operation, requestOrigin = origin) => fetch(origin + '/api/outlook/' + operation, {
    method: 'POST', body: JSON.stringify(operation === 'connect' ? settings : {}), headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
  });
  assert.equal((await post('connect', 'http://unrelated.invalid')).status, 403);
  assert.deepEqual(await (await post('connect')).json(), { authorizationUrl });
  const callback = await fetch(origin + '/auth/callback?code=synthetic', { redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/#outlook-connected');
  await worker.sync(); await worker.sync();
  const state = await (await fetch(origin + '/api/outlook/status')).json();
  assert.equal(state.accountType, 'personal');
  assert.equal(state.connected, true); assert.equal(state.sync.history.length, 1);
  assert.ok(state.sync.history[0].summary);
  assert.equal(state.sync.history[0].actions[0].status, 'added');
  assert.equal(requestedMime, 1); assert.equal(inference, 1);
  const { tasks } = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].due_at, '2026-11-16T09:00:00.000Z');
  await post('disconnect');
  assert.equal((await (await fetch(origin + '/api/outlook/status')).json()).sync, null);
});
