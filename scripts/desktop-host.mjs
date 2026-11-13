import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { ensureDesktopData } from '../backend/src/desktop-data.ts';
import { loadRuntimeOptions } from '../backend/src/runtime-options.ts';
import { parseDailyOverviewText } from '../contracts/daily-overview.ts';
import { desktopPaths } from './desktop-paths.mjs';
import { createDesktopLogger } from './desktop-logs.mjs';
import { createImportClient } from './import-client.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const userAt = args.indexOf('--user-data-dir');
const paths = desktopPaths(appRoot, userAt >= 0 ? args[userAt + 1] : undefined);
const emit = line => process.stdout.write(line + '\n');
let child, imports, logger = () => true, stopping = false, initialized = false, startupTimer;
let errorCode = 'BACKEND_EXIT', childExit;
const input = createInterface({ input: process.stdin });
const safeEnv = { ...process.env }; delete safeEnv.NODE_OPTIONS; delete safeEnv.NODE_PATH;

function finish(code) {
  clearTimeout(startupTimer); input.close(); process.stdin.destroy(); process.exitCode = code;
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true; clearTimeout(startupTimer); imports?.dispose(); logger('STOP_REQUESTED');
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: 'focusdesk-stop' }, () => {});
    const timer = setTimeout(() => { logger('STOP_TIMEOUT'); child.kill(); }, 8000); timer.unref();
    await childExit; clearTimeout(timer);
  }
  logger('APPLICATION_STOPPED'); finish(code);
}
function fail(code) {
  errorCode = /^[A-Z_]{1,64}$/.test(code ?? '') ? code : 'APPLICATION_FAILED';
  logger('APPLICATION_ERROR', { code: errorCode }); emit('ERROR|' + errorCode); void stop(1);
}
async function networkCheck() {
  if (process.platform !== 'win32') { emit('NETWORK|UNAVAILABLE'); return; }
  const script = "$ErrorActionPreference='Stop'; $p=Get-NetFirewallProfile -Name Private; $n=@(Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory); $r=@(Get-NetFirewallApplicationFilter -Program $env:FOCUSDESK_RUNTIME -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {$_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and ($_.Profile -match 'Private|Any')}); @{enabled=[bool]$p.Enabled; privateNetwork=($n -contains 'Private'); allowed=($r.Count -gt 0)} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 7000, env: { ...safeEnv, FOCUSDESK_RUNTIME: paths.runtime } });
    const result = JSON.parse(stdout);
    logger('NETWORK_CHECK', { code: result.allowed ? 'ALLOW_RULE_FOUND' : 'CHECK_PRIVATE_PERMISSION' });
    emit(`NETWORK|${result.enabled ? 'ENABLED' : 'DISABLED'}|${result.privateNetwork ? 'PRIVATE' : 'OTHER'}|${result.allowed ? 'ALLOW_RULE_FOUND' : 'CHECK_PERMISSION'}`);
  } catch { logger('NETWORK_CHECK', { code: 'UNAVAILABLE' }); emit('NETWORK|UNAVAILABLE'); }
}
input.on('line', line => {
  if (line === 'STOP') void stop();
  else if (line === 'NETWORK') void networkCheck();
  else if (initialized && line.startsWith('IMPORT\t')) void imports.preview(line.slice(7));
  else if (initialized && line === 'IMPORT_COMMIT') void imports.commit();
  else if (line === 'IMPORT_CANCEL') imports?.cancel();
});
input.on('close', () => { if (!stopping) void stop(); });
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
process.on('uncaughtException', () => fail('APPLICATION_FAILED'));
process.on('unhandledRejection', () => fail('APPLICATION_FAILED'));

try {
  if (path.resolve(process.execPath).toLowerCase() !== paths.runtime.toLowerCase()) throw Error('RUNTIME_MISMATCH');
  if (!process.versions.node.startsWith('24.')) throw Error('RUNTIME_VERSION');
  logger = createDesktopLogger(paths.logsPath);
  const metadata = JSON.parse(await readFile(path.join(paths.appRoot, 'package.json'), 'utf8'));
  if (!logger('APPLICATION_START', { version: String(metadata.version), runtime: process.versions.node })) throw Error('LOG_WRITE_FAILED');
  await access(path.join(paths.dist, 'index.html'));
  await ensureDesktopData(paths.userRoot);
  if (stopping) throw Error('STOPPED');
  const options = await loadRuntimeOptions(paths.appRoot, ['--config', paths.configPath]);
  // Windows can permit overlapping wildcard/specific-address TCP bindings.
  // Reject an existing loopback listener before starting our own LAN service.
  const occupied = await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: options.port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(true));
  });
  if (occupied) throw Error('PORT_IN_USE');
  if (stopping) throw Error('STOPPED');
  child = fork(paths.backend, ['--data', paths.dataPath, '--config', paths.configPath, '--dist', paths.dist], {
    execPath: paths.runtime, cwd: paths.appRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: safeEnv,
  });
  childExit = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  imports = createImportClient({ backend: child, backupsPath: paths.backupsPath, onEvent: event => {
    if (event.type === 'confirm') emit(`IMPORT_CONFIRM|${event.taskCount}|${event.focusActive ? 'ACTIVE' : 'IDLE'}`);
    else if (event.type === 'result') {
      logger('IMPORT_RESULT', { code: event.ok ? 'OK' : event.code }); emit(`IMPORT_RESULT|${event.ok ? 'OK' : event.code}`);
    }
  } });
  // Only structured event codes are recorded, never backend output, tasks,
  // request bodies or arbitrary exception messages.
  child.stdout.resume(); child.stderr.on('data', data => {
    const message = data.toString();
    if (/already in use/.test(message)) errorCode = 'PORT_IN_USE';
    if (/data.*already in use/i.test(message)) errorCode = 'DATA_LOCKED';
  });
  child.on('error', () => fail('BACKEND_START_FAILED'));
  child.on('exit', (code, signal) => {
    logger('BACKEND_EXIT', { exitCode: code ?? -1, signal: signal ?? 'none' });
    if (!stopping) fail(errorCode);
  });
  child.on('message', async message => {
    if (message?.type === 'focusdesk-error') { errorCode = message.code; return; }
    if (message?.type !== 'focusdesk-ready' || stopping || initialized) return;
    try {
      const url = new URL(message.connectionUrl);
      if (url.protocol !== 'http:' || !url.hostname.startsWith('127.')) throw Error('INVALID_BINDING');
      const [dashboard, overview] = await Promise.all([
        fetch(url.origin + '/', { signal: AbortSignal.timeout(5000) }),
        fetch(url.origin + '/api/v1/daily-overview', { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!dashboard.ok || !overview.ok) throw Error('DATA_INVALID');
      await dashboard.arrayBuffer(); parseDailyOverviewText(await overview.text());
      if (stopping) return;
      initialized = true; clearTimeout(startupTimer);
      logger('BACKEND_READY', { port: Number(url.port), pid: child.pid }); emit('READY|' + url.port);
    } catch (error) { fail(error.message === 'INVALID_BINDING' ? 'INVALID_BINDING' : 'DATA_INVALID'); }
  });
  startupTimer = setTimeout(() => fail('STARTUP_TIMEOUT'), 20000); startupTimer.unref();
} catch (error) {
  if (stopping) { finish(0); }
  else {
  const code = ['RUNTIME_MISMATCH', 'RUNTIME_VERSION', 'PORT_IN_USE'].includes(error.message) ? error.message :
    error.code === 'IMPORT_INVALID_SOURCE' ? 'DATA_INVALID' : /configuration/i.test(error.message) ? 'CONFIG_INVALID' : 'USER_DATA_UNAVAILABLE';
  fail(code);
  }
}
