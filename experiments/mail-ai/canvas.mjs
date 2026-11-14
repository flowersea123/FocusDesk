const MAX_PAGES = 25;
const MAX_ASSIGNMENTS = 2_500;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

function schoolOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Canvas origin must contain only the HTTPS school origin.');
  }
  return url.origin;
}

function numericId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  return /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : null;
}

/** Match only a course assignment at the explicitly configured school.
 * Query strings and anchors in genuine Canvas notification links do not change its ID. */
export function canvasAssignmentKey(link, trustedOrigin) {
  try {
    const origin = schoolOrigin(trustedOrigin);
    const url = new URL(link);
    const match = /^\/courses\/([1-9]\d{0,19})\/assignments\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
    if (url.origin !== origin || url.username || url.password || !match) return null;
    return `canvas:${origin}/courses/${match[1]}/assignments/${match[2]}`;
  } catch {
    return null;
  }
}

function canvasTime(value) {
  if (value === null) return null;
  const match = typeof value === 'string' &&
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (match) {
    const date = new Date(match[1] + 'T00:00:00Z');
    const time = new Date(value);
    if (Number.isFinite(+date) && date.toISOString().startsWith(match[1] + 'T') && Number.isFinite(+time)) {
      return time.toISOString();
    }
  }
  throw new Error('Canvas returned an invalid timestamp.');
}

function assignmentMetadata(item, origin, courseId) {
  const id = numericId(item?.id);
  if (!id || numericId(item.course_id) !== courseId || typeof item.name !== 'string' || !item.name.trim()) {
    throw new Error('Canvas returned invalid assignment metadata.');
  }
  const submission = item.submission;
  if (submission != null && (typeof submission !== 'object' || Array.isArray(submission))) {
    throw new Error('Canvas returned invalid submission metadata.');
  }
  const submissionState = submission?.workflow_state ?? null;
  if (submissionState !== null && typeof submissionState !== 'string') {
    throw new Error('Canvas returned an invalid submission state.');
  }
  const submittedAt = canvasTime(submission?.submitted_at ?? null);
  let submitted = null;
  if (submittedAt || submissionState === 'submitted' || submissionState === 'pending_review') {
    submitted = true;
  } else if (submission == null || submissionState === 'unsubmitted') {
    submitted = false;
  }
  // Graded without a submission time can be a manually assigned grade.
  // Keep it visible with unknown submission status instead of importing a new task.
  const url = `${origin}/courses/${courseId}/assignments/${id}`;
  return {
    id, name: item.name, dueAt: canvasTime(item.due_at), url,
    sourceKey: canvasAssignmentKey(url, origin), submitted,
    excused: submission?.excused === true, submissionState,
  };
}

function nextPage(header, current, endpoint) {
  if (!header) return null;
  let next = null;
  // Canvas links are enclosed in '<' and '>'; a cursor can itself contain commas.
  for (const entry of header.split(/,(?=\s*<)/)) {
    const parts = /^\s*<([^>]+)>\s*(;.*)$/.exec(entry);
    const rel = parts && /;\s*rel\s*=\s*(?:"([^"]+)"|([^\s;,]+))/i.exec(parts[2]);
    if (!rel) throw new Error('Canvas returned an invalid pagination header.');
    if (!(rel[1] ?? rel[2]).toLowerCase().split(/\s+/).includes('next')) continue;
    const target = new URL(parts[1], current);
    if (next || target.origin !== endpoint.origin || target.pathname !== endpoint.pathname ||
        target.username || target.password || target.hash) {
      throw new Error('Canvas returned an unexpected pagination URL.');
    }
    next = target;
  }
  return next;
}

async function readPage(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Canvas assignment request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('Canvas returned no assignment list.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_PAGE_BYTES) throw new Error('Canvas assignment page exceeds the 4 MiB read limit.');
    chunks.push(chunk);
  }
  let items;
  try {
    items = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new Error('Canvas did not return a JSON assignment list. Check the school URL and account access.');
  }
  if (!Array.isArray(items)) throw new Error('Canvas did not return an assignment list.');
  return items;
}

/** Read exactly one course as the authenticated user. Return only metadata and
 * never silently pass partial coverage to the caller. No link from a message is fetched. */
export async function readCanvasAssignments({ origin, courseId, accessToken, fetcher = fetch }) {
  const school = schoolOrigin(origin);
  const course = numericId(courseId);
  if (!course) throw new Error('Provide a numeric Canvas course ID.');
  if (typeof accessToken !== 'string' || !accessToken || /\s/.test(accessToken)) {
    throw new Error('Provide a Canvas access token.');
  }
  const endpoint = new URL(`/api/v1/courses/${course}/assignments`, school);
  endpoint.searchParams.set('override_assignment_dates', 'true');
  endpoint.searchParams.set('include[]', 'submission');
  endpoint.searchParams.set('per_page', '100');
  const visited = new Set();
  const assignments = new Map();
  const signal = AbortSignal.timeout(30_000);
  let url = endpoint;
  while (url) {
    if (visited.size >= MAX_PAGES || visited.has(url.href)) {
      throw new Error('Canvas pagination did not finish within the 25-page limit or repeated a page.');
    }
    visited.add(url.href);
    const response = await fetcher(url.href, {
      method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/json+canvas-string-ids', Authorization: `Bearer ${accessToken}` },
    });
    for (const item of await readPage(response)) {
      const record = assignmentMetadata(item, school, course);
      assignments.set(record.id, record);
      if (assignments.size > MAX_ASSIGNMENTS) throw new Error('Canvas course exceeds the 2500-assignment read limit.');
    }
    url = nextPage(response.headers.get('Link'), url, endpoint);
  }
  return [...assignments.values()];
}
