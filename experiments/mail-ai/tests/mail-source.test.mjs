import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readEml, readOutlook } from '../mail-source.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR4nGNoaGBoaAAABgYCASzBUNcAAAAASUVORK5CYII=', 'base64');
const assignment = 'https://class.example.edu/courses/4/assignments/13';
const token = 'synthetic-local-test';
const graphInbox = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages';

function eml(headers, body) { return headers.join('\r\n') + '\r\n\r\n' + body; }
function multipart(parts) {
  return eml(['Message-ID: <demo@example.invalid>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="local-boundary"'],
    parts.map(part => '--local-boundary\r\n' + part + '\r\n').join('') + '--local-boundary--\r\n');
}
function imagePart(bytes, mime = 'image/png', disposition = 'attachment') {
  return eml(['Content-Type: ' + mime, 'Content-Disposition: ' + disposition, 'Content-Transfer-Encoding: base64'], bytes.toString('base64'));
}
async function temporaryFile(t, bytes) {
  const folder = await mkdtemp(path.join(tmpdir(), 'FocusDesk 邮件 '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, '课程样例.eml');
  await writeFile(filename, bytes);
  return filename;
}

test('EML decodes Chinese headers and body, keeps receipt time and stable IDs across file paths', async t => {
  const subject = '阅读作业';
  const body = '请在后天下午三点提交。\n作业 ' + assignment;
  const raw = eml(['Received: from example.invalid by test.invalid; Sat, 14 Nov 2026 10:05:00 +0800',
    'Date: Sat, 14 Nov 2026 09:00:00 +0800', 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=',
    'Message-ID: <stable@example.invalid>', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'], Buffer.from(body).toString('base64'));
  const result = await readEml(await temporaryFile(t, raw));
  assert.match(result.id, /^eml:[a-f\d]{64}$/);
  assert.equal(result.receivedAt, '2026-11-14T02:05:00.000Z');
  assert.equal(result.subject, subject); assert.equal(result.body, body);
  assert.deepEqual(result.sourceLinks, [assignment]); assert.deepEqual(result.images, []);
  assert.equal((await readEml(await temporaryFile(t, raw.replace('10:05:', '10:15:')))).id, result.id);
});

test('equivalent copies of an EML without a message ID are stable; missing or ambiguous timezone does not use host local time', async t => {
  const raw = eml(['Subject: Plain mail', 'Date: Sat, 14 Nov 2026 08:00:00'], 'A task');
  const a = await readEml(await temporaryFile(t, raw));
  const b = await readEml(await temporaryFile(t, raw));
  const c = await readEml(await temporaryFile(t, raw.replace('A task', 'Another task')));
  assert.equal(a.receivedAt, null); assert.equal(a.id, b.id); assert.notEqual(a.id, c.id);
});

test('HTML conversion preserves visible lines and Canvas URLs; both inline MIME and data URI copies yield one image', async t => {
  const html = `<html><head><style>unrelated css</style></head><body><p>Upload &amp; confirm</p><p>By 11:40</p><a href="${assignment}?source=mail&amp;from=notification">Open assignment</a><script>unrelated script</script><img src="https://unfetched.invalid/pixel.png"><img src="data:image/png;base64,${pixel.toString('base64')}"><img src="cid:sample"></body></html>`;
  const raw = multipart([eml(['Content-Type: text/html; charset=utf-8'], html), imagePart(pixel, 'image/png', 'inline')]);
  const result = await readEml(await temporaryFile(t, raw));
  assert.equal(result.body, 'Upload & confirm\n\nBy 11:40\nOpen assignment');
  assert.deepEqual(result.sourceLinks, [assignment]);
  assert.deepEqual(result.images, [{ mime: 'image/png', data: pixel }]);
});

test('multipart mail prefers an explicit plain alternative and retains attached JPEG', async t => {
  const jpeg = Buffer.from('/9j/wAALCAACAAIBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/ACv/2Q==', 'base64');
  const alternative = eml(['Content-Type: multipart/alternative; boundary="choices"'],
    '--choices\r\nContent-Type: text/plain\r\n\r\nA plain original sentence.\r\n' +
    '--choices\r\nContent-Type: text/html\r\n\r\n<a href="' + assignment + '">Decorated version</a>\r\n--choices--');
  const result = await readEml(await temporaryFile(t, multipart([alternative, imagePart(jpeg, 'image/jpeg')])));
  assert.equal(result.body, 'A plain original sentence.');
  assert.deepEqual(result.sourceLinks, [assignment]);
  assert.deepEqual(result.images, [{ mime: 'image/jpeg', data: jpeg }]);
});

test('image-only mail reaches the model and attachment-only unsupported formats have no usable content', async t => {
  const imageOnly = await readEml(await temporaryFile(t, multipart([imagePart(pixel)])));
  assert.equal(imageOnly.body, ''); assert.equal(imageOnly.images.length, 1);
  const pdf = await temporaryFile(t, multipart([eml(['Content-Type: application/pdf','Content-Disposition: attachment'], '%PDF')]));
  await assert.rejects(readEml(pdf), /没有可读取/);
});

test('oversized, malformed or excessively large-dimension images and excessive MIME size are explicitly rejected', async t => {
  const invalid = await temporaryFile(t, multipart([imagePart(Buffer.from('not an image'))]));
  await assert.rejects(readEml(invalid), /格式无效/);
  const big = Buffer.from(pixel); big.writeUInt32BE(65000, 16);
  await writeFile(invalid, multipart([imagePart(big)]));
  await assert.rejects(readEml(invalid), /尺寸过大/);
  await writeFile(invalid, multipart([imagePart(Buffer.alloc(2 * 1024 * 1024 + 1))]));
  await assert.rejects(readEml(invalid), /2 MiB/);
  await writeFile(invalid, ''); await truncate(invalid, 8 * 1024 * 1024 + 1);
  await assert.rejects(readEml(invalid), /8 MiB/);
});

test('Graph reads a local HTTP double through immutable, read-only inbox collection pages and MIME downloads', async t => {
  const seen = [];
  const raw = multipart([eml(['Content-Type: text/plain; charset=utf-8'], 'Read chapter 3.'), imagePart(pixel)]);
  const next = graphInbox + '?$skiptoken=A%2BB%3D';
  const double = createServer((req, res) => {
    seen.push({method:req.method, url:req.url, auth:req.headers.authorization, prefer:req.headers.prefer});
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('/$value')) res.end(raw);
    else if (url.searchParams.has('$skiptoken')) res.end(JSON.stringify({value:[{ id:'A+B/2=', receivedDateTime:'2026-11-13T09:00:00Z' }]}));
    else res.end(JSON.stringify({value:[{ id:'A+B/1=', receivedDateTime:'2026-11-14T01:00:00.000Z' }], '@odata.nextLink':next}));
  });
  double.listen(0,'127.0.0.1'); await once(double,'listening');
  t.after(() => new Promise(resolve => {double.close(resolve);double.closeAllConnections();}));
  const local = `http://127.0.0.1:${double.address().port}`;
  let fetched = 0;
  const fetcher = (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://graph.microsoft.com'); assert.equal(options.redirect, 'error');
    if (++fetched === 3) assert.equal(url.href, next);
    return fetch(local + url.pathname + url.search, options);
  };
  const result = await readOutlook({accessToken:token,limit:2,fetcher});
  assert.equal(result.length, 2); assert.notEqual(result[0].id, result[1].id);
  assert.match(result[0].id,/^outlook:/); assert.equal(result[0].receivedAt,'2026-11-14T01:00:00.000Z');
  assert.equal(result[0].body, 'Read chapter 3.'); assert.deepEqual(result[0].images,[{mime:'image/png',data:pixel}]);
  assert.equal(seen.length, 4);
  assert.ok(seen.every(r => r.method === 'GET' && r.auth === 'Bearer ' + token && r.prefer === 'IdType="ImmutableId"'));
  assert.ok(seen[1].url.includes('/A%2BB%2F1%3D/$value')); assert.match(seen[2].url,/skiptoken=A%2BB%3D/);
});

test('Graph reports incomplete reads for expired access, pagination problems, and bodies beyond the streamed byte limit', async () => {
  const run = fetcher => readOutlook({accessToken:token,limit:2,fetcher});
  await assert.rejects(run(async () => new Response('expired',{status:401})),/HTTP 401/);
  let calls = 0;
  await assert.rejects(run(async () => {calls++;return Response.json({value:[],'@odata.nextLink':'https://unrelated.invalid/more'});}),/分页/);
  assert.equal(calls,1);
  const loop = graphInbox+'?$skiptoken=repeat';
  await assert.rejects(run(async () => Response.json({value:[],'@odata.nextLink':loop})),/分页/);
  let chunks = 0;
  const responses = [Response.json({value:[{id:'id'}]}),new Response(new ReadableStream({pull(c){chunks++;c.enqueue(new Uint8Array(1024*1024));}}))];
  await assert.rejects(run(async () => responses.shift()),/超过大小上限/); assert.ok(chunks <= 11);
});

test('Graph can report a rejected message and return the next one within the original attempt limit', async () => {
  const unsupported = multipart([eml(['Content-Type: application/pdf', 'Content-Disposition: attachment'], '%PDF')]);
  const valid = eml(['Content-Type: text/plain; charset=utf-8'], 'Read this notice.');
  const firstPage = { value: [{ id: 'bad' }], '@odata.nextLink': graphInbox + '?$skiptoken=next' };
  const secondPage = { value: [{ id: 'bad' }, { id: 'good' }, { id: 'outside-limit' }], '@odata.nextLink': graphInbox + '?$skiptoken=more' };
  const oversized = () => new Response('x', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } });
  for (const [bad, reason] of [[() => new Response(unsupported), /没有可读取/], [oversized, /超过大小上限/]]) {
    const responses = [Response.json(firstPage), bad(), Response.json(secondPage), new Response(valid)];
    const failures = [];
    const messages = await readOutlook({ accessToken: token, limit: 2,
      fetcher: async () => { assert.ok(responses.length, 'fetched past attempt limit'); return responses.shift(); },
      onMessageError: ({ index, reason }) => failures.push({ index, reason }),
    });
    assert.equal(failures.length, 1); assert.equal(failures[0].index, 1); assert.match(failures[0].reason, reason);
    assert.deepEqual(messages.map(mail => mail.body), ['Read this notice.']);
    assert.equal(responses.length, 0);
  }
  const authFailure = [Response.json(firstPage), new Response('expired', { status: 401 })];
  await assert.rejects(readOutlook({ accessToken: token, fetcher: async () => authFailure.shift(),
    onMessageError: () => assert.fail('an account error must end the inbox read'),
  }), /HTTP 401/);
});
