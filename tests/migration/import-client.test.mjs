import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createImportClient } from '../../scripts/import-client.mjs';
import { MAX_TASKS } from '../../contracts/daily-overview.ts';

const SOURCE = {
  date: '2026-11-03', timezone: 'Asia/Shanghai',
  tasks: [{ id: 'synthetic-1', title: 'Synthetic import task', status: 'todo', due_at: null }],
};

class Backend extends EventEmitter {
  connected = true;
  messages = [];
  failure = null;
  send(message, callback) {
    if (this.failure === 'throw') throw new Error('PRIVATE_EXCEPTION_CONTENT');
    this.messages.push(message);
    this.emit('sent', message);
    callback?.(this.failure === 'callback' ? new Error('PRIVATE_EXCEPTION_CONTENT') : null);
    return true;
  }
}

async function nextRequest(backend, index = 0) {
  if (backend.messages[index]) return backend.messages[index];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { backend.off('sent', check); reject(new Error('Test IPC request did not arrive')); }, 1_000);
    function check() {
      if (!backend.messages[index]) return;
      clearTimeout(timer);
      backend.off('sent', check);
      resolve(backend.messages[index]);
    }
    backend.on('sent', check);
  });
}

async function fixture(t, { source = SOURCE, bytes, timeoutMs = 500 } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'FocusDesk 导入测试 '));
  const file = path.join(temporary, '选中的旧任务 PRIVATE_FILE.json');
  await writeFile(file, bytes ?? JSON.stringify(source));
  const backend = new Backend();
  const events = [];
  const backupsPath = path.join(temporary, 'backups');
  const client = createImportClient({ backend, backupsPath, onEvent: event => events.push(event), timeoutMs });
  t.after(async () => {
    client.dispose();
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(temporary));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(temporary).startsWith('FocusDesk 导入测试 ')) throw new Error('Unsafe temporary path');
    await rm(temporary, { recursive: true, force: true });
  });
  return { client, file, backend, events, backupsPath };
}

function previewReply(backend, request, extras = {}) {
  backend.emit('message', { type: 'focusdesk-import-preview', requestId: request.requestId,
    revision: 'current-revision', exists: true, taskCount: request.source.tasks.length, focusActive: false, ...extras });
}

async function confirm(harness) {
  const pending = harness.client.preview(harness.file);
  const request = await nextRequest(harness.backend, harness.backend.messages.length);
  previewReply(harness.backend, request);
  assert.equal((await pending).type, 'confirm');
  return request;
}

test('preview validates read-only data, emits summary only, and waits for explicit commit', async t => {
  const h = await fixture(t);
  const before = await readFile(h.file);
  const request = await confirm(h);
  assert.equal(request.type, 'focusdesk-import-preview');
  assert.deepEqual(request.source, SOURCE);
  assert.deepEqual(h.events, [{ type: 'confirm', taskCount: 1, focusActive: false }]);
  assert.equal(h.backend.messages.length, 1);
  assert.deepEqual(await readFile(h.file), before);
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_FILE|Synthetic import task|current-revision/);
});

test('commit sends only the confirmed immutable snapshot and revision despite later file or IPC-object mutation', async t => {
  const source = { ...SOURCE, tasks: Array.from({ length: MAX_TASKS }, (_, index) => ({ ...SOURCE.tasks[0], id: `task-${index}` })) };
  const h = await fixture(t, { source });
  const preview = await confirm(h);
  preview.source.tasks[0].title = 'Mutated fake IPC payload';
  await writeFile(h.file, JSON.stringify({ ...SOURCE, tasks: [] }));
  const pending = h.client.commit();
  const request = await nextRequest(h.backend, 1);
  assert.equal(request.type, 'focusdesk-import-commit');
  assert.equal(request.confirmed, true);
  assert.equal(request.revision, 'current-revision');
  assert.equal(request.backupsPath, h.backupsPath);
  assert.deepEqual(request.source, source);
  assert.notEqual(request.requestId, preview.requestId);
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: request.requestId, ok: true, code: 'IMPORT_OK' });
  assert.deepEqual(await pending, { type: 'result', ok: true, code: 'IMPORT_OK' });
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
});

test('preserves expired focus values for the backend to interpret without client clock normalization', async t => {
  const focus = { task_id: 'synthetic-1', started_at: '2001-01-01T00:00:00.000Z', ends_at: '2001-01-01T00:25:00.000Z' };
  const h = await fixture(t, { source: { ...SOURCE, focus } });
  const request = await confirm(h);
  assert.deepEqual(request.source.focus, focus);
});

test('preview and confirmed IPC import preserve work state, signal history and AI suggestions', async t => {
  const extended = {
    ...SOURCE,
    work_state: { goal: 'Complete the review', current_action: 'Read the draft', next_action: 'Write feedback' },
    signals: [{ id: 'manual-review', content: 'Review requested', source: 'Manual', created_at: '2026-11-11T08:00:00.000Z', priority: 'action_needed', status: 'acknowledged' }],
    ai_suggestion: '先完成提纲，再专注25分钟。',
  };
  const h = await fixture(t, { source: extended });
  const preview = await confirm(h);
  assert.deepEqual(preview.source, extended);
  preview.source.work_state.goal = 'Changed IPC object';
  preview.source.signals[0].content = 'Changed IPC signal';
  preview.source.ai_suggestion = 'Changed IPC advice';
  await writeFile(h.file, JSON.stringify(SOURCE));
  const pending = h.client.commit();
  const request = await nextRequest(h.backend, 1);
  assert.equal(request.type, 'focusdesk-import-commit');
  assert.equal(request.confirmed, true);
  assert.equal(request.revision, 'current-revision');
  assert.deepEqual(request.source, extended);
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: request.requestId, ok: true, code: 'IMPORT_OK' });
  assert.equal((await pending).ok, true);
  assert.doesNotMatch(JSON.stringify(h.events), /Complete the review|Review requested|Read the draft|先完成提纲/);
});

test('previews a Chinese task source without discarding its optional device title', async t => {
  const source = { ...SOURCE, tasks: [{ ...SOURCE.tasks[0], title: '看论文', device_title: 'Read paper' }] };
  const request = await confirm(await fixture(t, { source }));
  assert.deepEqual(request.source.tasks, source.tasks);
});

test('accepts exactly 4096 bytes without treating trailing JSON whitespace as extra capacity', async t => {
  const body = Buffer.from(JSON.stringify({ ...SOURCE, focus: null }));
  const bytes = Buffer.concat([body, Buffer.alloc(4096 - body.length, 32)]);
  const h = await fixture(t, { bytes });
  const request = await confirm(h);
  assert.equal(request.source.focus, null);
});

const invalidCases = [
  ['oversize bytes', { bytes: Buffer.alloc(4097, 32) }, 'IMPORT_TOO_LARGE'],
  ['strict UTF-8', { bytes: Buffer.from([0xff]) }, 'IMPORT_INVALID_UTF8'],
  ['invalid JSON', { bytes: Buffer.from('{private bad data') }, 'IMPORT_INVALID_JSON'],
  ['missing fields', { source: { tasks: [] } }, 'IMPORT_INVALID_SOURCE'],
  ['unknown root fields', { source: { ...SOURCE, privateExtra: 'PRIVATE_FIELD' } }, 'IMPORT_INVALID_SOURCE'],
  ['invalid task', { source: { ...SOURCE, tasks: [{ id: 't', title: 'Task', status: 'todo' }] } }, 'IMPORT_INVALID_SOURCE'],
  ['invalid device title', { source: { ...SOURCE, tasks: [{ ...SOURCE.tasks[0], device_title: '中文任务' }] } }, 'IMPORT_INVALID_SOURCE'],
  ['unsupported timezone', { source: { ...SOURCE, timezone: 'Europe/London' } }, 'IMPORT_UNSUPPORTED_DEVICE_TIMEZONE'],
  ['too many tasks', { source: { ...SOURCE, tasks: Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ ...SOURCE.tasks[0], id: `t-${i}` })) } }, 'IMPORT_INVALID_SOURCE'],
  ['invalid AI suggestion', { source: { ...SOURCE, ai_suggestion: 'x'.repeat(121) } }, 'IMPORT_INVALID_SOURCE'],
];
for (const [label, input, expected] of invalidCases) {
  test(`rejects ${label} before IPC without exposing contents`, async t => {
    const h = await fixture(t, input);
    assert.deepEqual(await h.client.preview(h.file), { type: 'result', ok: false, code: expected });
    assert.equal(h.backend.messages.length, 0);
    assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
    assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE|中文|FocusDesk.*测试|Synthetic import task/);
  });
}

test('unreadable file returns a safe code rather than a path-bearing exception', async t => {
  const h = await fixture(t);
  assert.equal((await h.client.preview(`${h.file}.missing`)).code, 'IMPORT_FILE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_FILE|ENOENT/);
});

test('cancel invalidates a completed preview and cannot submit', async t => {
  const h = await fixture(t);
  await confirm(h);
  h.client.cancel();
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
  assert.equal(h.backend.messages.length, 1);
});

test('cancel invalidates an outstanding preview and ignores its late response', async t => {
  const h = await fixture(t);
  const pending = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  h.client.cancel();
  previewReply(h.backend, request);
  assert.equal((await pending).code, 'IMPORT_CANCELLED');
  assert.equal(h.events.length, 0);
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
});

test('ignores mismatched request ids and message kinds until the matching preview arrives', async t => {
  const h = await fixture(t);
  const pending = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  previewReply(h.backend, { ...request, requestId: 'another-request' });
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: request.requestId, ok: true, code: 'IMPORT_OK' });
  assert.equal(h.events.length, 0);
  previewReply(h.backend, request);
  assert.equal((await pending).type, 'confirm');
});

test('a new preview supersedes the old pending operation and its late reply cannot replace the current draft', async t => {
  const h = await fixture(t);
  const first = h.client.preview(h.file);
  const firstRequest = await nextRequest(h.backend);
  const second = h.client.preview(h.file);
  assert.equal((await first).code, 'IMPORT_CANCELLED');
  const secondRequest = await nextRequest(h.backend, 1);
  assert.notEqual(firstRequest.requestId, secondRequest.requestId);
  previewReply(h.backend, firstRequest, { revision: 'obsolete-revision' });
  assert.equal(h.events.length, 0);
  previewReply(h.backend, secondRequest, { revision: 'latest-revision' });
  await second;
  const commit = h.client.commit();
  const request = await nextRequest(h.backend, 2);
  assert.equal(request.revision, 'latest-revision');
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: request.requestId, ok: true });
  await commit;
});

test('a new preview supersedes an earlier file read before it can send IPC', async t => {
  const h = await fixture(t);
  const first = h.client.preview(h.file);
  const second = h.client.preview(h.file);
  assert.equal((await first).code, 'IMPORT_CANCELLED');
  const request = await nextRequest(h.backend);
  previewReply(h.backend, request);
  assert.equal((await second).type, 'confirm');
  assert.equal(h.backend.messages.length, 1);
});

test('preview timeout clears pending source, ignores late replies, and prohibits commit', async t => {
  const h = await fixture(t, { timeoutMs: 50 });
  const pending = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  assert.equal((await pending).code, 'IMPORT_TIMEOUT');
  previewReply(h.backend, request);
  assert.equal(h.events.some(event => event.type === 'confirm'), false);
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
});

test('commit timeout is reported safely and is never automatically retried', async t => {
  const h = await fixture(t, { timeoutMs: 50 });
  await confirm(h);
  assert.equal((await h.client.commit()).code, 'IMPORT_TIMEOUT');
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
  assert.equal(h.backend.messages.length, 2);
});

test('duplicate commit or new preview during commit is rejected without resending or replacing data', async t => {
  const h = await fixture(t);
  await confirm(h);
  const pending = h.client.commit();
  const request = await nextRequest(h.backend, 1);
  assert.equal(h.client.cancel(), false, 'cannot undo a commit already sent to the backend');
  assert.equal((await h.client.commit()).code, 'IMPORT_BUSY');
  assert.equal((await h.client.preview(h.file)).code, 'IMPORT_BUSY');
  assert.equal(h.backend.messages.length, 2);
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: request.requestId, ok: false, code: 'REVISION_CONFLICT' });
  assert.equal((await pending).code, 'REVISION_CONFLICT');
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
});

test('malformed preview responses are rejected rather than enabling a commit', async t => {
  const h = await fixture(t);
  const pending = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  previewReply(h.backend, request, { revision: 'invalid revision', taskCount: 999 });
  assert.equal((await pending).code, 'IMPORT_INVALID_RESPONSE');
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
});

test('real preview error responses preserve their safe backend code and never enable commit', async t => {
  const h = await fixture(t);
  const pending = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  h.backend.emit('message', { type: 'focusdesk-import-preview', requestId: request.requestId,
    ok: false, code: 'IMPORT_INVALID_SOURCE', message: 'PRIVATE_SOURCE_CONTENT' });
  assert.deepEqual(await pending, { type: 'result', ok: false, code: 'IMPORT_INVALID_SOURCE' });
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
  assert.equal(h.events.some(event => event.type === 'confirm'), false);
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_SOURCE_CONTENT/);
});

test('ignores errors of a different operation response type even when request ids match', async t => {
  const h = await fixture(t);
  const preview = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: request.requestId, ok: false, code: 'IMPORT_FAILED' });
  assert.equal(h.events.length, 0);
  previewReply(h.backend, request);
  assert.equal((await preview).type, 'confirm');
  const commit = h.client.commit();
  const commitRequest = await nextRequest(h.backend, 1);
  h.backend.emit('message', { type: 'focusdesk-import-preview', requestId: commitRequest.requestId, ok: false, code: 'IMPORT_FAILED' });
  assert.equal(h.events.length, 1);
  h.backend.emit('message', { type: 'focusdesk-import-result', requestId: commitRequest.requestId, ok: true });
  assert.equal((await commit).ok, true);
});

test('backend error messages are not surfaced and unsafe codes become generic', async t => {
  const h = await fixture(t);
  const pending = h.client.preview(h.file);
  const request = await nextRequest(h.backend);
  h.backend.emit('message', { type: 'focusdesk-import-preview', requestId: request.requestId, ok: false, code: 'C:\\PRIVATE_FILE', message: 'PRIVATE_CONTENT' });
  assert.equal((await pending).code, 'IMPORT_FAILED');
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE/);
});

for (const failure of ['throw', 'callback', 'disconnected']) {
  test(`send ${failure} returns a safe unavailable code`, async t => {
    const h = await fixture(t);
    if (failure === 'disconnected') h.backend.connected = false;
    else h.backend.failure = failure;
    assert.equal((await h.client.preview(h.file)).code, 'IMPORT_BACKEND_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_EXCEPTION/);
  });
}

test('backend disconnect resolves pending operations and clears the confirmed source', async t => {
  const h = await fixture(t);
  await confirm(h);
  const pending = h.client.commit();
  h.backend.emit('disconnect');
  assert.equal((await pending).code, 'IMPORT_BACKEND_UNAVAILABLE');
  assert.equal((await h.client.commit()).code, 'IMPORT_NOT_READY');
});

test('dispose detaches listeners, cancels pending work, and disables further requests', async t => {
  const h = await fixture(t);
  const pending = h.client.preview(h.file);
  await nextRequest(h.backend);
  h.client.dispose();
  h.client.dispose();
  assert.equal((await pending).code, 'IMPORT_CANCELLED');
  for (const name of ['message', 'error', 'exit', 'disconnect']) assert.equal(h.backend.listenerCount(name), 0);
  assert.equal((await h.client.preview(h.file)).code, 'IMPORT_DISPOSED');
  assert.equal((await h.client.commit()).code, 'IMPORT_DISPOSED');
});
