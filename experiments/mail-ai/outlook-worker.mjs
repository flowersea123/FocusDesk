import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { analyzeMail, beijingMinute } from './analyze.mjs';
import { assessMail } from './assess.mjs';
import { calendarDeadline, planChoices, planRevision, readCalendar, saveMailPlan, selectedPlan } from './mail-calendar.mjs';
import * as graph from './outlook-delta.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const pendingAction = action => ['pending','retry','full'].includes(action.status);
const pending = row => Boolean(row.message) || row.actions.some(pendingAction);
const iso = time => new Date(time).toISOString();
const wait = failures => Math.min(15 * 60_000, 10_000 * 2 ** Math.min(7, Math.max(0, failures - 1)));

async function writeState(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); } finally { await fd.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

async function loadState(file, since) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.messages) || !data.receipts || !Number.isFinite(Date.parse(data.since))) throw Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, since, cursor: null, lastSyncAt: null, graphAfter: 0, messages: [], receipts: {} };
    throw new Error('本地 Outlook 同步记录无法读取。已保留原文件。');
  }
}

function publicRow(row, entries, timezone) {
  const { id, receivedAt, subject, summary, status, reason } = row;
  const actions = planChoices(row).map(({ sourceKey, ...choice }) => ({ ...choice, dueDate: calendarDeadline(choice, timezone), planRevision: planRevision(entries.get(choice.id)), entry: entries.get(choice.id) ?? null }));
  return { id, receivedAt, subject, summary, status, reason, actions };
}

/** One host owns stateDir; credentials are obtained from getSession and never stored here. */
export function createOutlookWorker({
  stateDir, getSession, hub = 'http://127.0.0.1:8787', endpoint, model, canvasOrigin, intervalMs = 60_000, now = Date.now,
  readPage = graph.readOutlookDeltaPage, readMail = graph.readOutlookDeltaMail,
  analyze = analyzeMail, assess = assessMail, save = saveMailPlan, calendar = readCalendar,
} = {}) {
  if (!stateDir || typeof getSession !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Outlook 同步配置无效。');
  let running = false, timer, flight, generation = 0, stopped = false;
  let view = null, account = null, lastError = null, lastPollAt = null, nextSyncAt = null;
  let calendarView = null;
  const status = (limit = 60) => {
    const entries = new Map(calendarView?.entries.map(entry => [entry.id, entry]));
    const rows = view?.messages ?? [];
    const phase = lastError ? 'error' : !account ? 'disconnected' : view?.cursor?.phase === 'incremental' ? 'incremental' : 'baseline';
    return { running, syncing: Boolean(flight), connected: Boolean(account), phase, lastPollAt, lastSyncAt: view?.lastSyncAt ?? null,
      lastError, nextSyncAt, pendingCount: rows.filter(pending).length,
      history: [...rows].sort((a,b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? '')).slice(0, limit).map(row => publicRow(row, entries, calendarView?.timezone)),
      historyCount: rows.length, today: calendarView?.today ?? beijingMinute(iso(now())).slice(0, 10),
      counts: { messages: rows.length, processed: rows.filter(r => r.summary !== null).length,
        review: rows.filter(r => r.status === 'review').length, added: (view ? Object.values(view.receipts) : []).filter(r => r.status === 'added').length } };
  };

  async function cycle(gen, manual) {
    const active = () => gen === generation;
    let session;
    lastPollAt = iso(now()); lastError = null;
    try { session = await getSession({ forceRefresh: false }); }
    catch { if (active()) { account = null; view = null; lastError = '无法取得 Outlook 授权，请检查连接。'; } return; }
    if (!active()) return;
    if (!session?.accountId || !session.accessToken) { view = null; account = null; return; }
    const identity = session.accountId;
    if (account !== identity) { view = null; calendarView = null; }
    account = identity;
    const file = path.join(stateDir, 'outlook-' + hash(identity) + '.json');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const since = Number.isFinite(Date.parse(session.connectedAt)) ? iso(Date.parse(session.connectedAt)) : iso(now());
    const data = await loadState(file, since);
    if (!active()) return;
    view = data;
    const flush = () => writeState(file, data);
    if (data.cursor === null) await flush(); // Establish connection time before network I/O.
    let refreshed = false;
    async function withToken(request) {
      try { return await request(session.accessToken); }
      catch (error) {
        if (error.status !== 401 || refreshed || !active()) throw error;
        refreshed = true;
        const next = await getSession({ forceRefresh: true });
        if (!next?.accessToken || next.accountId !== identity || !active()) throw error;
        session = next;
        return request(session.accessToken);
      }
    }
    const seen = new Set(data.messages.map(row => row.id));
    let blocked = now() < data.graphAfter;
    if (blocked) lastError = 'Outlook 要求稍后重试。';
    function graphFailure(error) {
      if (error.status === 429 || error.retryAfterMs > 0) {
        data.graphAfter = now() + Math.max(1000, Number(error.retryAfterMs) || intervalMs);
        blocked = true;
        lastError = 'Outlook 要求稍后重试。';
      } else if (error.status === 401 || error.status === 403) {
        blocked = true;
        lastError = 'Outlook 读取授权不可用，请重新连接。';
      }
    }
    if (!blocked) {
      let rebuilt = false;
      for (let page = 0; page < 8 && active(); page++) {
        let result;
        try {
          result = await withToken(accessToken => readPage({ accessToken, cursor: data.cursor, since: data.since }));
        } catch (error) {
          if (!active()) return;
          if (error.status === 410 && data.cursor && !rebuilt) {
            data.cursor = null; rebuilt = true; await flush(); continue;
          }
          graphFailure(error);
          lastError ??= '无法读取 Outlook 新邮件，下次继续同步。';
          await flush(); break;
        }
        if (!active()) return;
        for (const ref of result.messages) {
          if (seen.has(ref.id)) continue;
          seen.add(ref.id);
          data.messages.push({ id: ref.id, message: { id: ref.id, graphId: ref.graphId, receivedDateTime: ref.receivedDateTime },
            receivedAt: ref.receivedDateTime, subject: '', summary: null, status: 'queued', reason: null,
            attempts: 0, retryAt: 0, lastTried: 0, actions: [] });
        }
        // Persist the queued message IDs in the same atomic replacement as the delta cursor.
        data.cursor = result.cursor;
        if (!result.hasMore) data.lastSyncAt = iso(now());
        await flush();
        if (!result.hasMore) break;
      }
    }
    const work = data.messages.filter(row => pending(row) && (manual || row.retryAt <= now()))
      .sort((a,b) => a.lastTried - b.lastTried).slice(0,16);
    for (const row of work) {
      if (!active()) return;
      row.lastTried = now();
      if (row.message) {
        if (blocked) continue;
        let mail;
        try { mail = await withToken(accessToken => readMail({ accessToken, message: row.message })); }
        catch (error) {
          if (!active()) return;
          graphFailure(error);
          const permanent = error.permanent || [404,410,413,415,422].includes(error.status);
          row.status = permanent ? 'unavailable' : 'retry';
          row.reason = permanent ? '此封邮件不可读取或格式超限。' : '邮件暂时无法读取，将重试。';
          if (permanent) delete row.message;
          row.retryAt = now() + wait(++row.attempts);
          await flush(); continue;
        }
        if (!active()) return;
        row.subject = String(mail.subject ?? '').slice(0,512);
        try {
          const report = await analyze(mail, { endpoint, model });
          if (!active()) return;
          row.actions = assess(mail, report, { canvasOrigin }).map(candidate => ({
            sourceKey: candidate.sourceKey, title: candidate.title, dueAt: candidate.dueAt, dueDate: candidate.dueDate, verified: !candidate.reason,
            status: candidate.reason || !(candidate.dueDate || candidate.dueAt) ? 'review' : 'pending', reason: candidate.reason ?? null,
          }));
          row.summary = report.summary.slice(0,8000);
          delete row.message;
          row.attempts = 0;
        } catch {
          if (!active()) return;
          row.reason = '本机模型暂未完成分析，将重试。'; row.status = 'retry';
          row.retryAt = now() + wait(++row.attempts);
          await flush(); continue;
        }
        await flush(); // No need to read or infer again when the Hub is unavailable.
      }
      for (const action of row.actions.filter(pendingAction)) {
        if (!active()) return;
        const choice = planChoices(row)[row.actions.indexOf(action)];
        const key = hash(choice.sourceKey);
        const receipt = data.receipts[key];
        if (receipt) {
          const sameDeadline = action.dueAt ? Date.parse(receipt.dueAt) === Date.parse(action.dueAt) : !receipt.dueAt && receipt.dueDate === choice.dueDate;
          action.status = sameDeadline ? 'existing' : 'review';
          action.reason = action.status === 'review' ? '同一来源的截止时间发生变化，请核对。' : null;
        } else if (!choice.dueDate || (action.dueAt && Date.parse(action.dueAt) <= now())) {
          action.status = 'expired'; action.reason = '截止时间已过。';
        } else {
          let result;
          try { result = await save({ hub, ...choice, plannedDate: choice.dueDate, automatic: true }); }
          catch { result = { status: 'retry', reason: '本机 Hub 暂时无法保存，将重试。' }; }
          action.status = result.status; action.reason = result.reason ?? null;
          if (result.status === 'added' || result.status === 'existing') {
            data.receipts[key] = { dueAt: action.dueAt, dueDate: choice.dueDate, status: result.status };
          }
        }
        await flush(); // Record success even if stop() was requested during the external write.
      }
      row.status = pending(row) ? 'retry' : row.actions.some(a => a.status === 'review') ? 'review' : 'processed';
      row.reason = pending(row) ? row.actions.find(pendingAction)?.reason : null;
      row.retryAt = pending(row) ? now() + wait(++row.attempts) : 0;
      await flush();
    }
  }

  function sync(manual = true) {
    if (flight) return flight;
    const gen = generation;
    stopped = false;
    clearTimeout(timer); nextSyncAt = null;
    flight = cycle(gen, manual).catch(() => {
      if (gen === generation) lastError = '同步未能完成，请检查本机记录目录并重试。';
    }).finally(() => {
      flight = null;
      if (running && !stopped) {
        nextSyncAt = iso(now() + intervalMs);
        timer = setTimeout(() => { void sync(false); }, intervalMs);
        timer.unref?.();
      }
    }).then(status);
    return flight;
  }
  return {
    start() { if (!running) { running = true; return sync(false); } return flight ?? Promise.resolve(status()); },
    sync: () => sync(true),
    async stop() {
      running = false; stopped = true; generation++;
      clearTimeout(timer); nextSyncAt = null; lastError = null; lastPollAt = null; view = null; account = null; calendarView = null;
      if (flight) await flight;
    },
    async history(limit = 60) {
      const gen = generation, identity = account;
      let calendarError = null;
      if (view && identity) {
        try {
          const current = await calendar(hub);
          if (generation === gen && account === identity) calendarView = current;
        } catch { calendarError = '日历暂时无法读取。'; }
      }
      return { ...status(limit), calendarError };
    },
    async plan(input) {
      const row = view?.messages.find(message => message.id === input.messageId);
      const choice = row && planChoices(row).find(item => item.id === input.actionId);
      if (!account || !choice) throw Error('这封邮件或所选事项已不可用，请刷新。');
      return save({ hub, ...selectedPlan(choice, input) });
    },
    status,
  };
}
