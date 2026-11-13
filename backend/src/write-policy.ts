import type { IncomingMessage } from 'node:http';
import { isIPv4 } from 'node:net';
import { MAX_OVERVIEW_BYTES } from '../../contracts/daily-overview.ts';

export class WriteRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIPv4(ipv4) && ipv4.split('.')[0] === '127';
}

export function checkWritePolicy(address: string | undefined, host: string | undefined, origin: string | undefined, contentType: string | undefined) {
  let localHost = false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
    localHost = hostname === 'localhost' || isLoopback(hostname);
  } catch { /* Invalid Host cannot authorize a write. */ }
  if (!isLoopback(address) || !localHost || !host || origin !== `http://${host}`) {
    throw new WriteRequestError(403, 'WRITE_FORBIDDEN', 'Task editing requires a same-origin browser on this computer.');
  }
  if (!contentType || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
    throw new WriteRequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json with UTF-8 encoding.');
  }
}

/** Bound both accumulated bytes and total upload time, without destroying the
 * socket before the service can send its structured rejection response. */
export function readUpdateBody(request: IncomingMessage, timeoutMs = 5_000): Promise<string> {
  const declared = Number(request.headers['content-length']);
  if (declared > MAX_OVERVIEW_BYTES) {
    return Promise.reject(new WriteRequestError(413, 'BODY_TOO_LARGE', 'Task update exceeds 4096 bytes.'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', failed);
    };
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error); };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OVERVIEW_BYTES) { fail(new WriteRequestError(413, 'BODY_TOO_LARGE', 'Task update exceeds 4096 bytes.')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { reject(new WriteRequestError(400, 'INVALID_TASK_UPDATE', 'Task update must be valid UTF-8.')); }
    };
    const aborted = () => fail(new WriteRequestError(400, 'INCOMPLETE_BODY', 'Task update upload was interrupted.'));
    const failed = () => fail(new WriteRequestError(400, 'INCOMPLETE_BODY', 'Task update upload failed.'));
    const timer = setTimeout(() => fail(new WriteRequestError(408, 'BODY_TIMEOUT', 'Task update upload timed out.')), timeoutMs);
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', failed);
  });
}
