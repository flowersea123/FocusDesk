import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import PostalMime from 'postal-mime';
import { parseFragment } from 'parse5';

const MiB = 1024 * 1024;
export const MAX_EML_BYTES = 8 * MiB;
const maxImageBytes = 2 * MiB;
const inbox = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages';
const blockTags = new Set(['br', 'div', 'p', 'li', 'td', 'tr', 'table', 'section', 'blockquote', 'h1', 'h2', 'h3', 'h4']);
const hiddenTags = new Set(['head', 'title', 'style', 'script', 'template', 'noscript']);

// An unavailable or oversized MIME part can be reported for one message.
// Authentication, transport and mailbox-list failures abort the read.
class ContentReadError extends Error {}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

// A Web reader for HTTP and an async file stream both enforce the limit even
// when Content-Length is absent or a file grows after stat().
async function collectBytes(stream, limit, label) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new ContentReadError(`${label}超过大小上限，请缩小范围后重试。`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function checkImage(data, mime) {
  if (!data.length || data.length > maxImageBytes) throw new Error('每张邮件图片须在 2 MiB 以内。');
  let width, height;
  if (mime === 'image/png' && data.length >= 24 &&
      data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      data.toString('ascii', 12, 16) === 'IHDR') {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  }
  if (mime === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8) {
    // JPEG stores frame dimensions after a variable number of metadata segments.
    let pos = 2;
    while (pos + 3 < data.length && data[pos] === 0xff) {
      while (data[pos] === 0xff) pos++;
      const marker = data[pos++];
      if (marker === 0xda || marker === 0xd9 || pos + 2 > data.length) break;
      const length = data.readUInt16BE(pos);
      if (length < 2 || pos + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = data.readUInt16BE(pos + 3);
        width = data.readUInt16BE(pos + 5);
        break;
      }
      pos += length;
    }
  }
  if (!width || !height) throw new Error('邮件图片格式无效，请提供 PNG 或 JPEG 文件。');
  if (width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('邮件图片尺寸过大，请裁剪后重试。');
}

function addAssignmentLink(links, raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !/^\/courses\/\d+\/assignments\/\d+\/?$/.test(url.pathname)) return;
    links.add(url.origin + url.pathname.replace(/\/$/, ''));
  } catch { /* Plain text can contain incomplete URLs. */ }
}

function htmlBody(html, sourceLinks, addImage) {
  if (Buffer.byteLength(html) > 4 * MiB) throw new Error('邮件 HTML 超过 4 MiB，请导出较短正文。');
  const text = [];
  const nodes = [parseFragment(html)];
  while (nodes.length) {
    const node = nodes.pop();
    if (node === null) { text.push('\n'); continue; }
    if (node.nodeName === '#text') { text.push(node.value); continue; }
    if (hiddenTags.has(node.tagName)) continue;
    if (node.tagName === 'a') addAssignmentLink(sourceLinks, node.attrs.find(a => a.name === 'href')?.value);
    if (node.tagName === 'img') {
      const src = node.attrs.find(a => a.name === 'src')?.value ?? '';
      const prefix = /^data:(image\/png|image\/jpeg);base64,/i.exec(src);
      if (prefix) addImage(prefix[1].toLowerCase(), Buffer.from(src.slice(prefix[0].length), 'base64'));
    }
    if (blockTags.has(node.tagName)) { text.push('\n'); nodes.push(null); }
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) nodes.push(children[i]);
  }
  return text.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function explicitTimestamp(input) {
  if (typeof input !== 'string' || !/(?:Z|[+-]\d\d:?\d\d|UTC|GMT)\s*(?:\([^)]*\))?$/i.test(input.trim())) return null;
  const time = Date.parse(input);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

async function decodeMessage(bytes, graphMessage) {
  const parsed = await PostalMime.parse(bytes, {
    maxNestingDepth: 32, maxHeadersSize: 256 * 1024, maxPartCount: 256, forceRfc822Attachments: true,
  });
  const images = [], imageHashes = new Set(), links = new Set();
  let totalImageBytes = 0;
  const addImage = (mime, data) => {
    checkImage(data, mime);
    const key = digest(data);
    if (imageHashes.has(key)) return;
    totalImageBytes += data.length;
    if (images.length >= 3 || totalImageBytes > 4 * MiB) throw new Error('每封邮件最多读取 3 张不同的图片，合计最多 4 MiB。');
    imageHashes.add(key);
    images.push({ mime, data });
  };
  const htmlText = parsed.html ? htmlBody(parsed.html, links, addImage) : '';
  const body = parsed.text?.trim() || htmlText;
  const subject = parsed.subject?.trim() ?? '';
  if (Buffer.byteLength(body) > 64 * 1024 || Buffer.byteLength(subject) > 4096) throw new Error('邮件正文或主题过长，请先选取相关邮件内容。');
  for (const match of body.matchAll(/https:\/\/[^\s<>"'，。；）]+/gi)) {
    addAssignmentLink(links, match[0].replace(/[),.;!?]+$/, ''));
  }
  for (const attachment of parsed.attachments) {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime === 'image/png' || mime === 'image/jpeg') addImage(mime, Buffer.from(attachment.content));
  }
  if (!body && !images.length) throw new Error('此邮件没有可读取的正文或 PNG/JPEG 图片。');
  const id = graphMessage ? 'outlook:' + digest(graphMessage.id) : 'eml:' + digest(parsed.messageId || bytes);
  // The newest Received field is prepended by the receiving server. Exported
  // mail may only have a sender Date. A timezone-free header cannot anchor DDLs.
  const receipt = parsed.headers.find(h => h.key === 'received')?.value.split(';').at(-1);
  const sent = parsed.headers.find(h => h.key === 'date')?.value;
  const receivedAt = graphMessage ? explicitTimestamp(graphMessage.receivedDateTime) :
    explicitTimestamp(receipt) ?? explicitTimestamp(sent);
  return { id, subject, body, receivedAt, images, sourceLinks: [...links] };
}

export async function readEmlBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_EML_BYTES) {
    throw new Error('请选择一个非空且不超过 8 MiB 的 EML 文件。');
  }
  return decodeMessage(bytes);
}

export async function readEml(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_EML_BYTES) throw new Error('请选择一个不超过 8 MiB 的 EML 文件。');
    const bytes = await collectBytes(file.createReadStream({ autoClose: false }), MAX_EML_BYTES, 'EML');
    return await readEmlBytes(bytes);
  } finally { await file.close(); }
}

async function graphGet(url, accessToken, fetcher, bytes, accept) {
  const response = await fetcher(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: 'Bearer ' + accessToken, Accept: accept, Prefer: 'IdType="ImmutableId"' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    const message = `Microsoft Graph 读取失败 (HTTP ${response.status})。`;
    if ([404, 410, 413, 415, 422].includes(response.status)) throw new ContentReadError(message);
    throw new Error(message);
  }
  if (!response.body) throw new ContentReadError('Microsoft Graph 未返回可读取的内容。');
  if (Number(response.headers.get('Content-Length')) > bytes) {
    await response.body.cancel();
    throw new ContentReadError('Graph 邮件响应超过大小上限。');
  }
  return collectBytes(response.body, bytes, 'Graph 邮件响应');
}

function inboxPage(nextLink) {
  const url = new URL(nextLink);
  // Graph owns the opaque skip token. Forward it unchanged to the same inbox
  // collection, never to links found in a message or a third-party host.
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash ||
      !/^\/v1\.0\/me\/mailfolders(?:\/inbox|\('inbox'\))\/messages\/?$/i.test(url.pathname)) {
    throw new Error('Graph 分页地址不属于预期的收件箱。');
  }
  return url.href;
}

async function readOutlookMessage(item, accessToken, fetcher) {
  const url = inbox + '/' + encodeURIComponent(item.id) + '/$value';
  const bytes = await graphGet(url, accessToken, fetcher, MAX_EML_BYTES, '*/*');
  try { return await decodeMessage(bytes, item); }
  catch (error) { throw new ContentReadError(error.message, { cause: error }); }
}

// onMessageError receives { index, reason } for each failed message, where
// index starts at 1 among the distinct messages attempted in this read.
export async function readOutlook({ accessToken, limit = 5, fetcher = fetch, onMessageError } = {}) {
  if (typeof accessToken !== 'string' || !accessToken.trim() || /\s/.test(accessToken)) {
    throw new Error('需要当前账号具有 Mail.Read 委托权限的 Microsoft Graph 访问令牌。');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('每次读取邮件数量应为 1 至 10 封。');
  if (onMessageError !== undefined && typeof onMessageError !== 'function') throw new TypeError('onMessageError 必须是函数。');
  const query = new URLSearchParams({ $select: 'id,receivedDateTime', $orderby: 'receivedDateTime desc', $top: String(limit) });
  const messages = [], seenMessages = new Set(), pages = new Set();
  let page = inbox + '?' + query;
  while (page) {
    if (pages.has(page) || pages.size >= 20) throw new Error('Graph 分页未结束，请重新读取收件箱。');
    pages.add(page);
    const raw = await graphGet(page, accessToken, fetcher, 256 * 1024, 'application/json');
    const result = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(result?.value)) throw new Error('Graph 收件箱返回了无法识别的邮件列表。');
    for (const item of result.value) {
      if (typeof item?.id !== 'string' || !item.id || item.id === '.' || item.id === '..') throw new Error('Graph 邮件标识无效。');
      if (seenMessages.has(item.id)) continue;
      seenMessages.add(item.id);
      try { messages.push(await readOutlookMessage(item, accessToken, fetcher)); }
      catch (error) {
        if (!onMessageError || !(error instanceof ContentReadError)) throw error;
        await onMessageError({ index: seenMessages.size, reason: error.message });
      }
      if (seenMessages.size === limit) break;
    }
    const next = result['@odata.nextLink'];
    page = next && seenMessages.size < limit ? inboxPage(next) : null;
  }
  return messages;
}
