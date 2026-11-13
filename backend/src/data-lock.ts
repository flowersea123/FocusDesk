import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';

export class DataLockedError extends Error {
  code = 'DATA_LOCKED';
  constructor() { super('FocusDesk data is already in use by another process.'); }
}

/** Resolve aliases, even if the last path components have not been created. */
export async function canonicalDataPath(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalDataPath(parent), path.basename(absolute));
  }
}

/** The OS owns this lock's lifetime. No PID file, stale-file deletion, TCP port,
 * or process killing is used. Windows named pipes survive neither owner exit
 * nor a crash. Linux abstract sockets provide the same property for CI. */
export async function acquireDataLock(filename: string) {
  const dataPath = await canonicalDataPath(filename);
  const identity = process.platform === 'win32' ? dataPath.toLowerCase() : dataPath;
  const digest = createHash('sha256').update(identity).digest('hex');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\focusdesk-data-${digest}`
    : process.platform === 'linux' ? `\0focusdesk-data-${digest}` : null;
  if (!endpoint) throw new Error('The desktop data lock supports Windows and Linux only.');
  const owner = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.listen({ path: endpoint, exclusive: true, readableAll: false, writableAll: false }, () => {
        owner.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new DataLockedError();
    throw error;
  }
  owner.unref();
  let release: Promise<void> | undefined;
  return {
    dataPath,
    release(): Promise<void> {
      release ??= new Promise((resolve, reject) => owner.close(error => error ? reject(error) : resolve()));
      return release;
    },
  };
}
