import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { acquireDataLock } from '../../backend/src/data-lock.ts';
import { createOutlookAuth } from './outlook-auth.mjs';
import { createOutlookWorker } from './outlook-worker.mjs';

function applicationDirectory() {
  if (process.env.FOCUSDESK_OUTLOOK_DATA_DIR) return path.resolve(process.env.FOCUSDESK_OUTLOOK_DATA_DIR);
  const home = os.homedir();
  const parent = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(parent, 'FocusDesk', 'outlook');
}

export async function openOutlookService({ port, stateDir = applicationDirectory(), ...options }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireDataLock(path.join(stateDir, 'sync-owner'));
  try {
    const auth = createOutlookAuth({ port, stateDir });
    const worker = createOutlookWorker({ ...options, stateDir, getSession: settings => auth.session(settings), intervalMs: 60_000 });
    const service = outlookController(auth, worker);
    // A locked credential vault must not prevent opening the local setup page.
    worker.start();
    return { ...service, async close() { try { await worker.stop(); } finally { await lock.release(); } } };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export function outlookController(auth, worker) {
  let changing = false;
  async function change(operation) {
    if (changing) throw new Error('正在更新邮箱连接，请稍后再试。');
    changing = true;
    try {
      await worker.stop();
      return await operation();
    } finally { changing = false; worker.start(); }
  }
  return {
    async status() {
      const { connected, configured, clientId, tenantId, accountType, redirectUri } = await auth.status();
      return { connected, configured, clientId, tenantId, accountType, redirectUri, sync: connected && !changing ? worker.status() : null };
    },
    begin(settings) {
      if (changing) throw new Error('正在更新邮箱连接，请稍后再试。');
      return auth.begin(settings);
    },
    finish: params => change(() => auth.finish(params)),
    disconnect: () => change(() => auth.disconnect()),
    async sync() {
      if (changing || !(await auth.status()).connected) throw new Error('请先连接 Outlook。');
      // Progress and recoverable failures are reported by the worker on the status endpoint.
      return worker.sync();
    },
  };
}
