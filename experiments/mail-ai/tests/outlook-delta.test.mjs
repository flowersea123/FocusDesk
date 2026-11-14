import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { readOutlookDeltaMail, readOutlookDeltaPage } from '../outlook-delta.mjs';

const token = 'fake-delta-only-test';
const since = '2026-11-14T03:30:00.000Z';
const recent = '2026-11-14T03:31:00.000Z';
const past = '2026-11-13T09:00:00.000Z';
const origin = 'https://graph.microsoft.com';
const folders = origin + '/v1.0/me/mailFolders';
const folderId = 'AQFolder+/=';
const delta = `${folders}('${encodeURIComponent(folderId)}')/messages/delta`;
const baselineNext = delta + '?$skiptoken=page%2Btwo%3D';
const firstDelta = delta + '?$deltatoken=round%2Bone%3D';
const incrementNext = delta + '?$skiptoken=round2%2Bpage2';
const secondDelta = delta + '?$deltatoken=round%2Btwo%3D';
const reference = { phase: 'incremental', since, folderId, url: firstDelta };

test('two baseline pages and two incremental pages resume with immutable IDs and fetch MIME only on demand', async t => {
  const requests = [];
  const mailId = 'New+/1=';
  const row = (id, receivedDateTime) => ({ id, receivedDateTime });
  const pages = [
    { id: folderId },
    { value: [row('old', past)], '@odata.nextLink': baselineNext },
    { value: [row('old2', past), row('during-baseline', recent)], '@odata.deltaLink': firstDelta },
    { value: [], '@odata.nextLink': incrementNext },
    { value: [row('old', past), { id: 'read-state-only', isRead: true }, row(mailId, recent),
      row(mailId, recent), row('removed', recent), { id: 'removed', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': secondDelta },
  ];
  const api = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, prefer: req.headers.prefer });
    if (req.url.endsWith('/$value')) {
      res.end('Subject: Lab log\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease submit your lab log.');
    } else res.end(JSON.stringify(pages.shift()));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  t.after(() => new Promise(resolve => { api.close(resolve); api.closeAllConnections(); }));
  const fetcher = (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, origin); assert.equal(options.redirect, 'error');
    return fetch(`http://127.0.0.1:${api.address().port}${target.pathname}${target.search}`, options);
  };
  const read = cursor => readOutlookDeltaPage({ accessToken: token, since, cursor, fetcher });
  const first = await read(null);
  assert.deepEqual(first.messages, []); assert.equal(first.hasMore, true); assert.equal(first.cursor.phase, 'baseline');
  assert.equal(requests.length, 2); assert.equal(requests[0].path, '/v1.0/me/mailFolders/inbox?$select=id');
  const initial = new URL(requests[1].path, origin);
  assert.equal(initial.pathname, '/v1.0/me/mailFolders/AQFolder%2B%2F%3D/messages/delta');
  assert.equal(initial.searchParams.get('changeType'), 'created'); assert.equal(initial.searchParams.get('$select'), 'id,receivedDateTime');
  const lastBaseline = await read(JSON.parse(JSON.stringify(first.cursor)));
  assert.equal(lastBaseline.hasMore, false); assert.equal(lastBaseline.cursor.phase, 'incremental');
  assert.deepEqual(lastBaseline.messages.map(m => m.graphId), ['during-baseline']);
  const empty = await read(lastBaseline.cursor);
  assert.equal(empty.hasMore, true); assert.deepEqual(empty.messages, []);
  const changes = await read(JSON.parse(JSON.stringify(empty.cursor)));
  assert.deepEqual(requests.slice(2).map(r => origin + r.path), [baselineNext, firstDelta, incrementNext]);
  assert.equal(changes.hasMore, false); assert.equal(changes.cursor.url, secondDelta);
  assert.deepEqual(changes.messages.map(m => m.graphId), [mailId]); assert.match(changes.messages[0].id, /^outlook:[a-f\d]{64}$/);
  assert.ok(requests.every(r => r.auth === 'Bearer ' + token && r.method === 'GET' && r.prefer.includes('IdType="ImmutableId"')));
  assert.ok(requests.slice(1).every(r => r.prefer.includes('odata.maxpagesize=')));
  const mail = await readOutlookDeltaMail({ accessToken: token, message: changes.messages[0], fetcher });
  assert.equal(mail.id, changes.messages[0].id); assert.equal(mail.body, 'Please submit your lab log.'); assert.equal(mail.receivedAt, recent);
  assert.equal(requests.at(-1).path, '/v1.0/me/mailFolders/inbox/messages/New%2B%2F1%3D/$value');
  assert.equal(requests.at(-1).prefer, 'IdType="ImmutableId"');
});

test('invalid or foreign continuations are rejected before requests or cursor advancement', async () => {
  const bad = ['https://elsewhere.invalid/ignored', firstDelta.replace('AQFolder','aqfolder'),
    firstDelta.replace('/me/', '/users/other/'), firstDelta.replace('https://graph.', 'https://login@graph.'),
    firstDelta.replace('https:', 'http:'), firstDelta + '#extra'];
  for (const url of bad) {
    let called = false;
    await assert.rejects(readOutlookDeltaPage({ accessToken: token, cursor: { ...reference, url },
      fetcher: () => { called = true; throw new Error('unexpected request'); },
    }), /当前收件箱/);
    assert.equal(called, false);
  }
  for (const [data, reason] of [
    [{ value: [] }, /唯一/], [{ value: [], '@odata.nextLink': firstDelta, '@odata.deltaLink': secondDelta }, /唯一/],
    [{ value: [], '@odata.nextLink': firstDelta }, /重复/], [{ value: [], '@odata.nextLink': bad[0] }, /当前收件箱/],
    [{ value: [{ id: '..' }], '@odata.deltaLink': secondDelta }, /标识无效/],
    [{ value: [{ id: 'bad-time', receivedDateTime: '11/15/2026' }], '@odata.deltaLink': secondDelta }, /时区/],
  ]) {
    await assert.rejects(readOutlookDeltaPage({ accessToken:token, cursor:reference, fetcher:async () => Response.json(data) }), reason);
  }
  await assert.rejects(readOutlookDeltaMail({ accessToken: token, message: { id:'wrong', graphId:'other' },
    fetcher: () => assert.fail('invalid key requested MIME'),
  }), /不一致/);
});

test('410, account errors and rate limits are distinguishable and expired state can recover arrivals since connection', async () => {
  for (const status of [401, 403, 410, 429, 503]) {
    await assert.rejects(readOutlookDeltaPage({ accessToken: token, cursor: reference,
      fetcher: async () => new Response('', { status, headers: { 'Retry-After': '27' } }),
    }), e => e.status === status && e.retryAfterMs === 27_000);
  }
  const replies = [Response.json({ id: folderId }), Response.json({ value: [
    { id: 'already-in-inbox', receivedDateTime: past }, { id: 'arrived-while-offline', receivedDateTime: recent },
  ], '@odata.deltaLink': secondDelta })];
  const recovered = await readOutlookDeltaPage({ accessToken: token, since, fetcher: async () => replies.shift() });
  assert.deepEqual(recovered.messages.map(m => m.graphId), ['arrived-while-offline']);
  assert.equal(recovered.cursor.since, since);
  const args = { accessToken: token, message: recovered.messages[0] };
  await assert.rejects(readOutlookDeltaMail({ ...args, fetcher: async () => new Response('', { status: 410 }) }),
    e => e.status === 410 && e.permanent === true);
  await assert.rejects(readOutlookDeltaMail({ ...args, fetcher: async () => new Response('', { status: 429, headers: { 'Retry-After': '37' } }) }),
    e => e.status === 429 && e.retryAfterMs === 37_000 && !e.permanent);
});
