import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasAssignmentKey, readCanvasAssignments } from '../canvas.mjs';

const origin = 'https://lms.example.edu';
const settings = { origin, courseId: '31', accessToken: 'fixture-token' };
const path = '/api/v1/courses/31/assignments';

function assignment(id, fields = {}) {
  return { id, course_id: 31, name: 'Research plan', due_at: null, ...fields };
}

function page(items, link) {
  return Response.json(items, { headers: link ? { Link: link } : {} });
}

test('reads all assignment pages with current-user deadlines and submission info; retains only metadata', async () => {
  const next = origin + path + '?cursor=after,123';
  const calls = [];
  const results = await readCanvasAssignments({ ...settings, async fetcher(href, options) {
    const url = new URL(href);
    calls.push(href);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Accept, 'application/json+canvas-string-ids');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(url.pathname, path);
    if (calls.length === 1) {
      assert.equal(url.searchParams.get('override_assignment_dates'), 'true');
      assert.equal(url.searchParams.get('include[]'), 'submission');
      return page([assignment('9007199254740993', {
        due_at: '2026-11-22T17:15:00+08:00',
        all_dates: [{ base: true, due_at: '2026-11-20T09:00:00Z' }],
        description: 'private instructions', has_submitted_submissions: true,
        submission: { workflow_state: 'unsubmitted', body: 'private submission' },
      })], `<${href}>; rel="current", <${next}>; rel="next"`);
    }
    assert.equal(href, next);
    return page([assignment(2, { submission: { workflow_state: 'submitted', submitted_at: '2026-10-11T05:00:00Z' } }),
      assignment(3, { submission: { workflow_state: 'graded', submitted_at: null, excused: true } }),
      assignment(4), assignment(5, { submission: { workflow_state: 'pending_review' } })]);
  } });
  assert.equal(calls.length, 2);
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], {
    id: '9007199254740993', name: 'Research plan', dueAt: '2026-11-22T09:15:00.000Z',
    url: origin + '/courses/31/assignments/9007199254740993',
    sourceKey: canvasAssignmentKey(origin + '/courses/31/assignments/9007199254740993?module_item_id=8#details', origin),
    submitted: false, excused: false, submissionState: 'unsubmitted',
  });
  assert.equal(results[1].dueAt, null);
  assert.deepEqual(results.slice(1).map(a => a.submitted), [true, null, false, true]);
  assert.equal(results[2].excused, true);
});

test('email and Canvas normalize the same course assignment only on the trusted HTTPS origin', () => {
  const address = origin + '/courses/31/assignments/42';
  const expected = 'canvas:' + address;
  assert.equal(canvasAssignmentKey(address, origin), expected);
  assert.equal(canvasAssignmentKey('https://LMS.EXAMPLE.EDU:443/courses/31/assignments/42/?tracking=1#tag', origin + '/'), expected);
  for (const untrusted of [
    'https://lms.example.edu.other.test/courses/31/assignments/42',
    'https://lms.example.edu@other.test/courses/31/assignments/42',
    'https://spam@lms.example.edu/courses/31/assignments/42',
    'https://lms.example.edu:8080/courses/31/assignments/42',
    'http://lms.example.edu/courses/31/assignments/42',
    'https://lms.example.edu/courses/31/discussion_topics/42',
    address + '/submissions/11', 'an invalid URL',
  ]) assert.equal(canvasAssignmentKey(untrusted, origin), null);
  assert.equal(canvasAssignmentKey(address, ''), null);
});

test('ignores identical assignments repeated across pages; distinguishes an empty list and an incomplete read', async () => {
  const next = `<${origin}${path}?page=2>; rel=next`;
  let calls = 0;
  const data = await readCanvasAssignments({ ...settings, fetcher: async () =>
    ++calls === 1 ? page([assignment(42)], next) : page([assignment(42)]) });
  assert.equal(data.length, 1);
  assert.deepEqual(await readCanvasAssignments({ ...settings, fetcher: async () => page([]) }), []);
  calls = 0;
  await assert.rejects(readCanvasAssignments({ ...settings, fetcher: async () =>
    ++calls === 1 ? page([assignment(42)], next) : new Response('rate limited', { status: 429 }) }), /HTTP 429/);
});

test('refuses cross-origin, cross-course, unexpected and cyclic next links before sending a token', async () => {
  for (const next of ['https://elsewhere.example/api/v1/courses/31/assignments',
    origin + '/api/v1/courses/2/assignments', origin + '/logout', 'http://lms.example.edu' + path]) {
    let calls = 0;
    await assert.rejects(readCanvasAssignments({ ...settings, fetcher: async () => {
      calls++;
      return page([assignment(1)], `<${next}>; rel="next"`);
    } }), /unexpected pagination URL/);
    assert.equal(calls, 1);
  }
  let repeated = 0;
  await assert.rejects(readCanvasAssignments({ ...settings, fetcher: async href => {
    repeated++;
    return page([], `<${href}>; rel="next"`);
  } }), /repeated a page/);
  assert.equal(repeated, 1);
});

test('rejects invalid origins, response shapes, rolled-over dates and unrepresentable numeric IDs', async () => {
  for (const badOrigin of ['http://lms.example.edu', origin + '/subpath', 'https://u:p@lms.example.edu']) {
    await assert.rejects(readCanvasAssignments({ ...settings, origin: badOrigin,
      fetcher: async () => assert.fail('must validate before network') }), /HTTPS school origin/);
  }
  const invalidCases = [
    [new Response('<html>login</html>'), /JSON assignment list/],
    [page({ message: 'unexpected' }), /assignment list/],
    [page([assignment(1, { due_at: '2026-02-30T09:00:00Z' })]), /timestamp/],
    [page([assignment(1, { due_at: '2026-11-22T09:00:00' })]), /timestamp/],
    [page([assignment(Number.MAX_SAFE_INTEGER + 1)]), /invalid assignment metadata/],
  ];
  for (const [response, error] of invalidCases) {
    await assert.rejects(readCanvasAssignments({ ...settings, fetcher: async () => response }), error);
  }
});

test('bounds unexpected response size and pagination depth', async () => {
  await assert.rejects(readCanvasAssignments({ ...settings, fetcher: async () =>
    new Response(new Uint8Array(4 * 1024 * 1024 + 1)) }), /4 MiB/);
  let pages = 0;
  await assert.rejects(readCanvasAssignments({ ...settings, fetcher: async () =>
    page([], `<?page=${++pages}>; rel="next"`) }), /25-page limit/);
  assert.equal(pages, 25);
});
