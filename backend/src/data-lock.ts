import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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

async function acquireMacDataLock(dataPath: string, digest: string) {
  // A separate, stable inode keeps the lock valid when tasks.json is atomically
  // replaced. Never unlink this file: its existence does not mean it is locked.
  const lockPath = path.join(path.dirname(dataPath), `.focusdesk-data-${digest}.lock`);
  const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('The macOS data lock must be a regular file.');
    await new Promise<void>((resolve, reject) => {
      // lockf's descriptor mode implies -k. The child locks the shared open file
      // description; after it exits, this process's descriptor retains the lock.
      // No resident helper is needed, even if this process later receives SIGKILL.
      const command = spawn('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd], timeout: 5_000, killSignal: 'SIGKILL',
      });
      command.once('error', reject);
      command.once('close', (code, signal) => {
        if (code === 0) resolve();
        else if (code === 75) reject(new DataLockedError()); // EX_TEMPFAIL
        else reject(new Error(`macOS data lock could not be acquired (${signal ?? code}).`));
      });
    });
  } catch (error) {
    await file.close();
    throw error;
  }
  let release: Promise<void> | undefined;
  return {
    dataPath,
    release(): Promise<void> { return release ??= file.close(); },
  };
}

/** The OS owns this lock's lifetime. No PID files or stale-lock cleanup are
 * needed. Windows uses a named pipe, Linux an abstract socket, and macOS holds
 * a flock on an open descriptor independent of the replaceable task file. */
export async function acquireDataLock(filename: string) {
  const dataPath = await canonicalDataPath(filename);
  const identity = process.platform === 'win32' ? dataPath.toLowerCase() : dataPath;
  const digest = createHash('sha256').update(identity).digest('hex');
  if (process.platform === 'darwin') return acquireMacDataLock(dataPath, digest);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\focusdesk-data-${digest}`
    : process.platform === 'linux' ? `\0focusdesk-data-${digest}` : null;
  if (!endpoint) throw new Error('The desktop data lock supports Windows, macOS and Linux only.');
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
