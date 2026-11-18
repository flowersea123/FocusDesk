import { createPaperReader } from './paper-reader.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectForegroundHelper, ForegroundError, type ForegroundCapture, type ForegroundOptions } from './ipc.ts';

export type { ForegroundFrame, ForegroundCapture, ForegroundOptions } from './ipc.ts';
export { ForegroundError } from './ipc.ts';
const run = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const cache = join(homedir(), 'Library', 'Caches', 'FocusDesk', 'ForegroundCapture');
const appName = 'FocusDesk Capture.app';
const app = join(cache, appName);
const swift = join(directory, 'FocusDeskCapture.swift');
const plist = join(directory, 'Info.plist');
const unsupported = '前台自动记录需要 macOS 14 或更新版本。';
const toolsMissing = '首次使用需要 Apple Command Line Tools。安装后重新开始记录即可。';

function supportedOS(): boolean { return process.platform === 'darwin' && Number(release().split('.')[0]) >= 23; }
async function buildKey() {
  const [source, info] = await Promise.all([readFile(swift), readFile(plist)]);
  return createHash('sha256').update(source).update(info).update(process.arch + ':mac14-release-v1').digest('hex');
}
async function current(key: string): Promise<boolean> {
  try {
    if (await readFile(join(app, 'Contents/Resources/build-key'), 'utf8') !== key) return false;
    await access(join(app, 'Contents/MacOS/FocusDeskCapture'), constants.X_OK);
    await run('/usr/bin/codesign', ['--verify', '--strict', app], {timeout:5000});
    return true;
  } catch { return false; }
}
async function compiler() {
  try {
    // Check the selected toolchain before xcrun so discovery never opens an installer.
    await run('/usr/bin/xcode-select', ['-p'], {timeout:4000});
    const {stdout} = await run('/usr/bin/xcrun', ['--sdk','macosx','--find','swiftc'], {timeout:5000});
    return stdout.trim();
  } catch { throw new ForegroundError('DEVELOPER_TOOLS', toolsMissing); }
}
export async function foregroundSupport(): Promise<{supported: boolean; message: string}> {
  if (!supportedOS()) return {supported:false, message:unsupported};
  try {
    if (!await current(await buildKey())) await compiler();
    return {supported:true, message:'可跟随当前前台应用。首次开始时由 macOS 请求录屏权限。'};
  } catch (error) { return {supported:false, message:error instanceof ForegroundError ? error.message : '当前版本缺少前台采集助手。'}; }
}

/** Build under a Darwin lock, even when two local Hubs start at the same time. */
async function buildLocked() {
  const key = await buildKey();
  if (await current(key)) return;
  const binary = await compiler();
  const stage = await mkdtemp(join(cache, 'build-'));
  const candidate = join(stage, appName);
  const contents = join(candidate, 'Contents');
  const backup = join(stage, 'previous.app');
  let previous = false, keepBackup = false;
  try {
    await mkdir(join(contents,'MacOS'),{recursive:true});
    await mkdir(join(contents,'Resources'));
    await Promise.all([copyFile(plist,join(contents,'Info.plist')),writeFile(join(contents,'Resources/build-key'),key)]);
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const { stdout } = await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{timeout:5000});
    await run(binary,['-swift-version','5','-parse-as-library','-O','-target',arch+'-apple-macosx14.0','-sdk',stdout.trim(),swift,'-o',join(contents,'MacOS/FocusDeskCapture')],{timeout:120_000,maxBuffer:256_000});
    await run('/usr/bin/codesign',['--force','--sign','-','--identifier','app.focusdesk.ForegroundCapture',candidate],{timeout:15_000});
    await run('/usr/bin/codesign',['--verify','--strict',candidate],{timeout:5000});
    try { await rename(app,backup); previous = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try { await rename(candidate,app); } catch (e) {
      if (previous) {
        try { await rename(backup,app); } catch { keepBackup = true; }
      }
      throw e;
    }
  } finally { if (!keepBackup) await rm(stage,{recursive:true,force:true}); }
}
export async function prepareForegroundHelper(): Promise<string> {
  if (!supportedOS()) throw new ForegroundError('UNSUPPORTED', unsupported);
  if (await current(await buildKey())) return app;
  await compiler();
  await mkdir(cache,{recursive:true,mode:0o700});
  const info = await lstat(cache);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new ForegroundError('BUILD','采集助手缓存目录不可用。');
  await chmod(cache,0o700);
  try {
    await run('/usr/bin/lockf',['-k','-t','120',join(cache,'.build.lock'),process.execPath,fileURLToPath(import.meta.url),'--build-locked'],{timeout:150_000,maxBuffer:256_000});
  } catch { throw new ForegroundError('BUILD','未能编译本机采集助手。请检查 Apple Command Line Tools 与 macOS 14 或更新的 SDK。'); }
  return app;
}
export async function openForegroundCapture(options: ForegroundOptions = {}): Promise<ForegroundCapture> {
  if (options.signal?.aborted) throw new ForegroundError('ABORTED', '已停止本次前台记录。');
  const helper = await prepareForegroundHelper();
  const device = await connectForegroundHelper(options, async socket => {
    try { await run('/usr/bin/open',['-g','-n','-a',helper,'--args','--session',socket],{timeout:10_000}); }
    catch { throw new ForegroundError('LAUNCH','macOS 未能打开 FocusDesk Capture。请检查本机应用权限后重试。'); }
  });
  const readPaperHeader = createPaperReader();
  return { close:device.close, async capture(signal) {
    const frame = await device.capture(signal);
    return frame ? readPaperHeader(frame,signal) : null;
  }};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--build-locked') await buildLocked();
  else if (process.argv[2] === '--prepare') console.log(await prepareForegroundHelper());
}
