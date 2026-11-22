import type { ArxivPaper } from '../../../contracts/screen-checkpoint.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

export interface ForegroundFrame { image: string; app: string; pageKey: string; pageTitle?: string; paper?: ArxivPaper }
export interface ForegroundCapture {
  capture(signal?: AbortSignal): Promise<ForegroundFrame | null>;
  close(): Promise<void>;
}
export interface ForegroundOptions { signal?: AbortSignal; onStop?: (message: string) => void }
export class ForegroundError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const canceled = () => new ForegroundError('ABORTED', '已停止本次前台记录。');
const jsonLine = (message: unknown) => JSON.stringify(message) + '\n';
const maxLine = 1_405_000;

function validFrame(value: ForegroundFrame): boolean {
  if (!value || typeof value.app !== 'string' || !value.app || value.app.length > 128 ||
      !/^[0-9a-f]{64}$/.test(value.pageKey) ||
      (value.pageTitle !== undefined && (typeof value.pageTitle !== 'string' || [...value.pageTitle].length > 160)) ||
      typeof value.image !== 'string' || !value.image.startsWith('data:image/jpeg;base64,') || value.image.length > maxLine) return false;
  const encoded = value.image.slice(23);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length > 4 && bytes.length <= 1_048_576 && bytes.toString('base64') === encoded && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9;
}

/** The launcher passes only the private socket path to the named macOS app. */
export async function connectForegroundHelper(options: ForegroundOptions, launch: (socketPath: string) => Promise<void>): Promise<ForegroundCapture> {
  const { signal, onStop } = options;
  if (signal?.aborted) throw canceled();
  // Darwin's sun_path is 104 bytes. The randomized directory is accessible only to this user.
  const directory = await mkdtemp('/tmp/focusdesk-cap-');
  const socketPath = join(directory, 'session.sock');
  const secret = randomBytes(32).toString('hex');
  const server = createServer();
  const connections = new Set<Socket>();
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  let peer: Socket | undefined;
  let started = false;
  let closed: Promise<void> | undefined;
  let id = 0;
  let pending: { id: number; resolve: (r: ForegroundFrame | null) => void; reject: (e: Error) => void } | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { void finish(canceled(), false); };

  function finish(error: Error, notify: boolean): Promise<void> {
    if (closed) return closed;
    const done = Promise.withResolvers<void>(); closed = done.promise;
    clearTimeout(startupTimer);
    signal?.removeEventListener('abort', abort);
    ready.reject(error); pending?.reject(error); pending = undefined;
    for (const socket of connections) socket.destroy();
    if (server.listening) server.close();
    void rm(directory, { recursive: true, force: true }).then(done.resolve, done.reject);
    if (started && notify) { try { onStop?.(error.message); } catch { /* The native helper still closes. */ } }
    return closed;
  }
  function failure(message: string) { return new ForegroundError('HELPER_DISCONNECTED', message); }
  server.maxConnections = 4;
  server.on('connection', socket => {
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > maxLine) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
        buffer = buffer.slice(end + 1);
        if (!peer) {
          const token = typeof message?.secret === 'string' ? Buffer.from(message.secret) : Buffer.alloc(0);
          if (message?.event !== 'hello' || token.length !== secret.length || !timingSafeEqual(token, Buffer.from(secret))) { socket.destroy(); return; }
          peer = socket; socket.setTimeout(0); server.close();
          socket.write(jsonLine({ op: 'begin' }));
        } else if (socket !== peer) { socket.destroy(); return; }
        else if (message?.event === 'ready' && !started) { started = true; clearTimeout(startupTimer); ready.resolve(); }
        else if (message?.event === 'stopped' || message?.event === 'error') {
          const error = new ForegroundError(String(message.code ?? 'STOPPED'), String(message.message ?? '前台记录已停止。'));
          void finish(error, true); return;
        } else if (message?.event === 'frame' && started && pending && pending.id === message.id) {
          if (message.frame !== null && !validFrame(message.frame)) { void finish(failure('采集助手返回了无效的窗口画面。'), true); return; }
          pending.resolve(message.frame); pending = undefined;
        }
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      connections.delete(socket);
      if (peer === socket) void finish(failure('采集助手已退出，前台记录已停止。'), true);
    });
  });
  server.on('error', () => { void finish(failure('本机采集连接未能建立，请重试。'), true); });
  try {
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'secret'), secret, {mode: 0o600, flag: 'wx'});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) throw canceled();
    startupTimer = setTimeout(() => { void finish(failure('采集助手未准备就绪。请检查系统录屏权限后重试。'), false); }, 45_000);
    await launch(socketPath);
    await ready.promise;
  } catch (error) {
    await finish(error instanceof Error ? error : failure('启动采集助手失败。'), false);
    throw error;
  }
  return {
    async capture(frameSignal) {
      if (frameSignal?.aborted) throw canceled();
      if (closed || !peer) throw failure('前台记录已停止。');
      if (pending) return null;
      const ticket = ++id;
      const result = Promise.withResolvers<ForegroundFrame | null>();
      pending = {id: ticket, ...result};
      const cancelFrame = () => {
        if (pending?.id === ticket) { pending = undefined; peer?.write(jsonLine({op:'cancel', id:ticket})); result.reject(canceled()); }
      };
      const timer = setTimeout(() => { void finish(failure('读取当前窗口超时，记录已停止。可重新开始。'), true); }, 12_000);
      frameSignal?.addEventListener('abort', cancelFrame, {once:true});
      peer.write(jsonLine({op:'capture', id:ticket}));
      try { return await result.promise; }
      finally { clearTimeout(timer); frameSignal?.removeEventListener('abort', cancelFrame); }
    },
    close: () => finish(canceled(), false),
  };
}
