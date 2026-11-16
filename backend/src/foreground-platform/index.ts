import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const directory = fileURLToPath(new URL('./', import.meta.url));
const x11Script = path.join(directory, 'x11.py');
const MAX_RESPONSE = 1_410_000;
const failed = (message: string) => ({ supported: false, message });
type Support = { supported: boolean; message: string };
type Frame = { image: string; app: string; pageKey: string; pageTitle?: string };
type Options = { signal: AbortSignal; onStop: (reason?:string) => void };
type PlatformSession = { capture(signal: AbortSignal): Promise<Frame | null>; close(): Promise<void> };

async function windowsCompiler() {
  for (const architecture of ['Framework64', 'Framework']) {
    const filename = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe');
    try { await access(filename); return filename; } catch { /* Try the other desktop framework. */ }
  }
  return null;
}

async function probe(): Promise<Support> {
  if (process.platform === 'win32') {
    if (/^services$/i.test(process.env.SESSIONNAME || '')) return failed('请在已登录的 Windows 本机桌面中启动 FocusDesk。');
    return await windowsCompiler()
      ? {supported:true, message:'使用 Windows 前台窗口与独立的停止按钮，开始时检查桌面权限。'}
      : failed('缺少 Windows 桌面 .NET Framework 编译器，无法启动可见的录制窗口。');
  }
  if (process.platform !== 'linux') return failed('此平台使用其他原生适配器。');
  if (process.env.XDG_SESSION_TYPE !== 'x11' || process.env.WAYLAND_DISPLAY || !/^(:|unix:)\d+(\.\d+)?$/.test(process.env.DISPLAY || '')) {
    return failed('当前需要本机 X11 桌面。Wayland、远程 X11 和无图形桌面环境暂不能安全跟随前台窗口。');
  }
  try {
    const { stdout } = await run('python3', ['-I', '-B', x11Script, 'probe'], {timeout:3500, maxBuffer:8_192, windowsHide:true});
    const result = JSON.parse(stdout);
    return typeof result.supported === 'boolean' && typeof result.message === 'string' ? result : failed('X11 支持检测未返回有效结果。');
  } catch { return failed('无法验证 X11 桌面。需要 Python 3、python-xlib、Pillow、Tk、D-Bus 和可查询的桌面锁屏状态。'); }
}

let probeCache: {until:number; value:Promise<Support>} | undefined;
export function foregroundSupport(): Promise<Support> {
  if (!probeCache || probeCache.until <= Date.now()) probeCache = { until: Date.now() + 30_000, value: probe() };
  return probeCache.value;
}

function parseFrame(raw: unknown): Frame | null {
  if (raw === null) return null;
  const row = raw as {image:string; app:string; windowId:string; pageTitle:string} | null;
  if (!row || typeof row.image !== 'string' || row.image.length > 1_398_140 || !row.image.startsWith('data:image/jpeg;base64,/9j/') ||
      typeof row.windowId !== 'string' || !row.windowId || row.windowId.length > 100 ||
      typeof row.app !== 'string' || !row.app.trim() || row.app.length > 128 ||
      typeof row.pageTitle !== 'string' || row.pageTitle.length > 4096 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(row.app + row.pageTitle)) {
    throw new Error('前台窗口返回的帧格式无效。');
  }
  const encoded = row.image.slice('data:image/jpeg;base64,'.length);
  const jpeg = Buffer.from(encoded, 'base64');
  if (jpeg.length < 4 || jpeg.length > 1_048_576 || jpeg.readUInt16BE(0) !== 0xffd8 ||
      jpeg.readUInt16BE(jpeg.length-2) !== 0xffd9 || jpeg.toString('base64') !== encoded) {
    throw new Error('前台窗口返回的 JPEG 无效。');
  }
  const pageKey = createHash('sha256').update(JSON.stringify([row.windowId, row.app, row.pageTitle])).digest('hex');
  return { image:row.image, app:row.app, pageKey, pageTitle:[...row.pageTitle].slice(0,160).join('') };
}

// A ready message is emitted by the native indicator only after its Stop button is visible.
// A user click, EOF, startup failure, cancellation or malformed reply ends the native session.
export function connectForegroundHelper(child: ChildProcessWithoutNullStreams, {signal,onStop}: Options,
  cleanup: () => Promise<void> = async () => {}): Promise<PlatformSession> {
  return new Promise((resolve, reject) => {
    let ready = false, closing = false, stopped = false;
    let buffer = '';
    let pending: {resolve:(frame:Frame|null)=>void; reject:(reason:Error)=>void; detach:()=>void} | undefined;
    let exited!: () => void;
    const closed = new Promise<void>(done => { exited = done; });
    const startTimeout = setTimeout(() => finish(new Error('启动录制状态窗口超时。'), false), 8000);
    function finish(error: Error, notify: boolean) {
      if (closing) return;
      closing = true;
      clearTimeout(startTimeout);
      signal.removeEventListener('abort', aborted);
      if (!ready) reject(error);
      if (pending) { pending.detach(); pending.reject(error); pending = undefined; }
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (notify && ready && !stopped) { stopped = true; onStop(error.message); }
    }
    function aborted() { finish(new Error('前台采集已停止。'), false); }
    signal.addEventListener('abort', aborted, {once:true});
    const session: PlatformSession = {
      async close() { finish(new Error('前台采集已停止。'), false); await closed; },
      capture(captureSignal) {
        if (closing || captureSignal.aborted || pending) return Promise.resolve(null);
        return new Promise<Frame|null>((ok, bad) => {
          const cancel = () => finish(new Error('本次窗口采集已取消。'), !signal.aborted);
          const timeout = setTimeout(() => finish(new Error('前台应用未及时响应，录制已停止。'), true), 7000);
          pending = {resolve:ok, reject:bad, detach:() => {clearTimeout(timeout); captureSignal.removeEventListener('abort', cancel);}};
          captureSignal.addEventListener('abort', cancel, {once:true});
          child.stdin.write('capture\n');
        });
      },
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk:string) => {
      if (closing) return;
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE) { finish(new Error('前台窗口响应过大。'), true); return; }
      let end: number;
      while (!closing && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
        try {
          const result = JSON.parse(line);
          if (!ready && result.type === 'ready') { ready = true; clearTimeout(startTimeout); resolve(session); }
          else if (result.type === 'stopped') finish(new Error('录制窗口已关闭。'), true);
          else if (result.type === 'error') finish(new Error(typeof result.message === 'string' ? result.message.slice(0,240) : '无法采集前台窗口。'), true);
          else if (ready && result.type === 'frame' && pending) {
            const frame = parseFrame(result.frame); pending.detach(); pending.resolve(frame); pending = undefined;
          } else throw Error();
        } catch { finish(new Error('前台窗口响应无效。'), true); }
      }
    });
    child.stderr.resume(); // The protocol has explicit errors. Do not log raw window metadata.
    child.stdin.on('error', () => finish(new Error('录制窗口连接已关闭。'), true));
    child.once('error', () => finish(new Error('无法启动本机前台录制程序。'), true));
    child.once('close', () => {
      finish(new Error('录制窗口已关闭。'), true);
      cleanup().then(exited, exited);
    });
    if (signal.aborted) aborted();
  });
}

export async function openForegroundCapture(options: Options): Promise<PlatformSession> {
  options.signal.throwIfAborted();
  const support = await foregroundSupport();
  if (!support.supported) throw new Error(support.message);
  options.signal.throwIfAborted();
  if (process.platform === 'linux') {
    const helper = spawn('python3', ['-I', '-B', x11Script, 'session'], {stdio:'pipe'});
    return connectForegroundHelper(helper, options);
  }
  const compiler = await windowsCompiler();
  if (!compiler) throw Error('Windows 桌面编译组件不可用。');
  const temp = await mkdtemp(path.join(tmpdir(), 'focusdesk-foreground-'));
  const cleanup = () => rm(temp, {recursive:true, force:true, maxRetries:3, retryDelay:100});
  try {
    const program = path.join(temp, 'FocusDeskCapture.exe');
    await run(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/optimize+', '/r:System.Drawing.dll',
      '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/out:'+program, path.join(directory,'windows.cs')],
      {signal:options.signal,windowsHide:true,timeout:15_000,maxBuffer:32_768});
    options.signal.throwIfAborted();
    return await connectForegroundHelper(spawn(program, [path.join(directory,'sensitive-pattern.txt')], {stdio:'pipe',windowsHide:true}), options, cleanup);
  } catch (error) {
    await cleanup().catch(() => {});
    if (options.signal.aborted) options.signal.throwIfAborted();
    if (error instanceof Error && 'cmd' in error) throw new Error('Windows 桌面录制组件编译失败，请检查 .NET Framework 与应用控制设置。');
    throw error;
  }
}
