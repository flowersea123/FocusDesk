import { graphGet, outlookMessageKey, readOutlookMessage } from './mail-source.mjs';

const graph = 'https://graph.microsoft.com';
const folders = graph + '/v1.0/me/mailFolders';
const immutablePage = 'IdType="ImmutableId", odata.maxpagesize=50';

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    throw new Error('Outlook 同步时间须包含明确时区。');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('Outlook 同步时间无效。');
  return new Date(ms).toISOString();
}

function requireFolderId(id) {
  // Graph folder IDs are opaque and case sensitive. Reserved path characters
  // such as /, + and = must remain inside the encoded folder segment.
  if (typeof id !== 'string' || !id || id.length > 4096 || /[\u0000-\u0020\u007f]/.test(id) || id === '.' || id === '..') {
    throw new Error('Outlook 收件箱标识无效。');
  }
  return id;
}

function inboxContinuation(link, folderId) {
  if (typeof link !== 'string' || link.length > 32 * 1024 || /[\u0000-\u0020\u007f]/.test(link)) throw new Error('Outlook 同步分页地址无效。');
  const url = new URL(link);
  const path = decodeURIComponent(url.pathname);
  const match = /^\/v1\.0\/me\/mailfolders(?:\/([\s\S]+)|\('([\s\S]+)'\))\/messages\/(?:microsoft\.graph\.)?delta\/?$/i.exec(path);
  const folder = match?.[1] ?? match?.[2];
  if (url.origin !== graph || url.username || url.password || url.hash || !url.search ||
      (folder !== folderId && folder?.toLowerCase() !== 'inbox')) {
    throw new Error('Outlook 同步分页地址不属于当前收件箱。');
  }
  // Rebuilding searchParams would change the encoding of the opaque token.
  return link;
}

async function openInbox(accessToken, fetcher, since) {
  const start = timestamp(since);
  const metadata = await graphGet(folders + '/inbox?$select=id', accessToken, fetcher, 32 * 1024, 'application/json');
  const folderId = requireFolderId(JSON.parse(metadata.toString('utf8'))?.id);
  const query = new URLSearchParams({ $select: 'id,receivedDateTime', changeType: 'created' });
  return { phase: 'baseline', folderId, since: start,
    url: `${folders}/${encodeURIComponent(folderId)}/messages/delta?${query}` };
}

/** Read one metadata page. Persist its cursor and message refs in one transaction.
 * Save since at first connection and supply it again when rebuilding an expired
 * delta token. Only mail delivered since that time may enter the analysis queue.
 */
export async function readOutlookDeltaPage({ accessToken, cursor = null, since = new Date().toISOString(), fetcher = fetch } = {}) {
  const current = cursor ?? await openInbox(accessToken, fetcher, since);
  if (!['baseline', 'incremental'].includes(current.phase)) throw new Error('Outlook 同步阶段无效。');
  const folderId = requireFolderId(current.folderId);
  const connectedAt = timestamp(current.since);
  const url = inboxContinuation(current.url, folderId);
  const raw = await graphGet(url, accessToken, fetcher, 512 * 1024, 'application/json', immutablePage);
  const data = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(data?.value)) throw new Error('Outlook 同步响应缺少邮件列表。');
  const next = data['@odata.nextLink'], delta = data['@odata.deltaLink'];
  if ((next !== undefined) === (delta !== undefined)) throw new Error('Outlook 同步响应必须返回唯一的分页或增量地址。');
  const hasMore = next !== undefined;
  const nextUrl = inboxContinuation(hasMore ? next : delta, folderId);
  if (hasMore && nextUrl === url) throw new Error('Outlook 同步分页地址重复。');

  // Graph can replay entries or return removal and read-state changes even
  // with changeType=created. A date fence also admits mail arriving during a
  // multi-page baseline or a full resync after 410. The worker deduplicates
  // across pages by stable ID. No old MIME is requested to build a baseline.
  const refs = new Map();
  for (const item of data.value) {
    const id = outlookMessageKey(item?.id);
    if ('@removed' in item) { refs.delete(id); continue; }
    if (item.receivedDateTime == null) continue;
    const receivedDateTime = timestamp(item.receivedDateTime);
    if (Date.parse(receivedDateTime) >= Date.parse(connectedAt)) {
      refs.set(id, { id, graphId: item.id, receivedDateTime });
    }
  }
  return { cursor: { phase: hasMore ? current.phase : 'incremental', folderId, since: connectedAt, url: nextUrl },
    hasMore, messages: [...refs.values()] };
}

/** Resolve a queued Inbox reference only when the worker is ready for inference. */
export async function readOutlookDeltaMail({ accessToken, message, fetcher = fetch } = {}) {
  if (outlookMessageKey(message?.graphId) !== message.id) throw new Error('Outlook 邮件引用与稳定标识不一致。');
  return readOutlookMessage({ id: message.graphId, receivedDateTime: timestamp(message.receivedDateTime) }, accessToken, fetcher);
}
