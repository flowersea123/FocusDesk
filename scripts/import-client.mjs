import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { MAX_OVERVIEW_BYTES, parseDailyOverview } from '../contracts/daily-overview.ts';

class ImportFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

function safeCode(value, fallback = 'IMPORT_FAILED') {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function readSource(filePath) {
  let buffer;
  try {
    const file = await open(filePath, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ImportFailure('IMPORT_INVALID_SOURCE');
      if (info.size > MAX_OVERVIEW_BYTES) throw new ImportFailure('IMPORT_TOO_LARGE');
      buffer = Buffer.alloc(MAX_OVERVIEW_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_OVERVIEW_BYTES) throw new ImportFailure('IMPORT_TOO_LARGE');
      buffer = buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure('IMPORT_FILE_UNAVAILABLE');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new ImportFailure('IMPORT_INVALID_UTF8'); }
  let source;
  try { source = JSON.parse(text); }
  catch { throw new ImportFailure('IMPORT_INVALID_JSON'); }
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      Object.keys(source).some(key => !['date', 'timezone', 'tasks', 'focus', 'work_state', 'signals', 'ai_suggestion'].includes(key))) {
    throw new ImportFailure('IMPORT_INVALID_SOURCE');
  }
  let overview;
  try {
    overview = parseDailyOverview({ ...source, schema_version: '1.0', revision: 'import-validation', updated_at: '2000-01-01T00:00:00Z' });
  } catch { throw new ImportFailure('IMPORT_INVALID_SOURCE'); }
  if (!['UTC', 'Asia/Shanghai'].includes(overview.timezone)) throw new ImportFailure('IMPORT_UNSUPPORTED_DEVICE_TIMEZONE');
  return freeze({ date: overview.date, timezone: overview.timezone, tasks: overview.tasks,
    ...(Object.hasOwn(source, 'focus') ? { focus: overview.focus } : {}),
    ...(Object.hasOwn(source, 'work_state') ? { work_state: overview.work_state } : {}),
    ...(Object.hasOwn(source, 'signals') ? { signals: overview.signals } : {}),
    ...(Object.hasOwn(source, 'ai_suggestion') ? { ai_suggestion: overview.ai_suggestion } : {}) });
}

/** The host calls commit only after an explicit native confirmation. No logging or persistence occurs here. */
export function createImportClient({ backend, backupsPath, onEvent = () => {}, timeoutMs = 5_000 }) {
  let disposed = false;
  let active = null;
  let previewed = null;

  function notify(event) { try { onEvent(event); } catch { /* UI exceptions must not expose file contents. */ } }
  function result(code, emit = true) {
    const event = { type: 'result', ok: false, code: safeCode(code) };
    if (emit) notify(event);
    return event;
  }
  function finish(operation, event, emit = true) {
    if (active !== operation) return;
    clearTimeout(operation.timer);
    active = null;
    operation.resolve(event);
    if (emit) notify(event);
  }
  function cancelActive() {
    previewed = null;
    if (active) finish(active, result('IMPORT_CANCELLED', false), false);
  }
  function begin(kind) {
    const operation = { kind, requestId: randomUUID(), source: null, resolve: null, timer: null };
    const promise = new Promise(resolve => { operation.resolve = resolve; });
    active = operation;
    operation.timer = setTimeout(() => {
      previewed = null;
      finish(operation, result('IMPORT_TIMEOUT', false));
    }, timeoutMs);
    return { operation, promise };
  }
  function send(operation, message) {
    if (active !== operation) return;
    if (backend.connected === false) {
      finish(operation, result('IMPORT_BACKEND_UNAVAILABLE', false));
      return;
    }
    try {
      backend.send(message, error => {
        if (error) finish(operation, result('IMPORT_BACKEND_UNAVAILABLE', false));
      });
    } catch { finish(operation, result('IMPORT_BACKEND_UNAVAILABLE', false)); }
  }
  function onMessage(message) {
    const operation = active;
    if (!operation || !message || typeof message !== 'object' || message.requestId !== operation.requestId) return;
    const responseType = operation.kind === 'preview' ? 'focusdesk-import-preview' : 'focusdesk-import-result';
    if (message.type !== responseType) return;
    if (message.ok === false) {
      previewed = null;
      finish(operation, result(safeCode(message.code), false));
      return;
    }
    if (operation.kind === 'preview' && message.type === 'focusdesk-import-preview') {
      if (message.exists !== true || typeof message.revision !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(message.revision) ||
          message.taskCount !== operation.source?.tasks.length || typeof message.focusActive !== 'boolean') {
        finish(operation, result('IMPORT_INVALID_RESPONSE', false));
        return;
      }
      previewed = { source: operation.source, revision: message.revision };
      finish(operation, { type: 'confirm', taskCount: message.taskCount, focusActive: message.focusActive });
    } else if (operation.kind === 'commit' && message.type === 'focusdesk-import-result' && message.ok === true) {
      finish(operation, { type: 'result', ok: true, code: safeCode(message.code, 'IMPORT_OK') });
    }
  }
  function unavailable() {
    previewed = null;
    if (active) finish(active, result('IMPORT_BACKEND_UNAVAILABLE', false));
  }
  backend.on('message', onMessage);
  backend.on('error', unavailable);
  backend.on('exit', unavailable);
  backend.on('disconnect', unavailable);

  return {
    preview(filePath) {
      if (disposed) return Promise.resolve(result('IMPORT_DISPOSED', false));
      if (active?.kind === 'commit') return Promise.resolve(result('IMPORT_BUSY'));
      cancelActive();
      const { operation, promise } = begin('preview');
      void readSource(filePath).then(source => {
        if (active !== operation) return;
        operation.source = source;
        send(operation, { type: 'focusdesk-import-preview', requestId: operation.requestId, source: structuredClone(source) });
      }).catch(error => {
        finish(operation, result(error instanceof ImportFailure ? error.code : 'IMPORT_FAILED', false));
      });
      return promise;
    },
    commit() {
      if (disposed) return Promise.resolve(result('IMPORT_DISPOSED', false));
      if (active) return Promise.resolve(result('IMPORT_BUSY'));
      if (!previewed) return Promise.resolve(result('IMPORT_NOT_READY'));
      const draft = previewed;
      previewed = null; // A confirmation is single-use, including after failure or conflict.
      const { operation, promise } = begin('commit');
      send(operation, { type: 'focusdesk-import-commit', requestId: operation.requestId,
        source: structuredClone(draft.source), revision: draft.revision, confirmed: true, backupsPath });
      return promise;
    },
    cancel() {
      // Once sent, a confirmed commit may already be persisted by the backend.
      if (active?.kind === 'commit') return false;
      cancelActive();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelActive();
      backend.off('message', onMessage);
      backend.off('error', unavailable);
      backend.off('exit', unavailable);
      backend.off('disconnect', unavailable);
    },
  };
}
