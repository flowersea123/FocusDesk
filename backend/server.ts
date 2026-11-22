import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from './src/service.ts';
import { getServerInfo } from './src/network-info.ts';
import { loadRuntimeOptions } from './src/runtime-options.ts';
import { acquireDataLock, DataLockedError } from './src/data-lock.ts';
import { createOverviewLoader, RevisionConflictError, SourceError } from './src/overview-loader.ts';
import { ImportSourceError, validateDesktopSource } from './src/desktop-data.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function notify(message: object) {
  if (process.connected && process.send) process.send(message, () => undefined);
}
let dataLock: Awaited<ReturnType<typeof acquireDataLock>> | undefined;
let startupStage = 'CONFIG_INVALID';
try {
  const options = await loadRuntimeOptions(root, process.argv.slice(2));
  startupStage = 'DATA_INVALID';
  try { dataLock = await acquireDataLock(options.dataPath); }
  catch (error) {
    if (error instanceof DataLockedError) {
      console.error(`FocusDesk data is already in use (requested port ${options.port}). Close its existing window before starting again.`);
      notify({ type: 'focusdesk-error', code: 'DATA_LOCKED' });
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    } else throw error;
  }
  if (dataLock) {
  const loader = createOverviewLoader(dataLock.dataPath);
  const server = createDemoServer({ ...options, dataPath: dataLock.dataPath, loader });
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const stop = () => {
    if (stopped) return stopped;
    stopping = true;
    console.log('\nStopping FocusDesk.');
    stopped = (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 2_000);
      force.unref();
      try { await Promise.all([closed, server.stopRecording(), loader.close()]); }
      finally {
        clearTimeout(force);
        await dataLock!.release();
        if (process.connected) process.disconnect();
      }
    })();
    stopped.catch(() => { process.exitCode = 1; notify({ type: 'focusdesk-error', code: 'STOP_FAILED' }); });
    return stopped;
  };
  server.on('error', error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') console.error(`FocusDesk port ${options.port} is already in use. Close the other FocusDesk window, or change port in focusdesk.config.json and restart.`);
    else if (code === 'EACCES') console.error(`FocusDesk cannot listen on port ${options.port}. Choose another port in focusdesk.config.json.`);
    else console.error(`FocusDesk could not start: ${error.message}`);
    notify({ type: 'focusdesk-error', code: code === 'EADDRINUSE' ? 'PORT_IN_USE' : code === 'EACCES' ? 'PORT_DENIED' : 'START_FAILED' });
    process.exitCode = 1;
    void stop();
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    const info = getServerInfo(address.address, address.port);
    console.log('\nFocusDesk is running. Keep this window open. Ctrl+C stops the service.');
    if (info.local_url) console.log(`Dashboard (manage tasks on this PC): ${info.local_url}`);
    if (info.connection_url) console.log(`Connection help / updated IP addresses: ${info.connection_url}`);
    notify({ type: 'focusdesk-ready', connectionUrl: info.connection_url, dashboardUrl: info.local_url, dataPath: dataLock!.dataPath });
    if (!info.local_url) console.log('Loopback editing is unavailable with this specific LAN binding. Set host to 0.0.0.0 for the normal Windows setup.');
    if (!info.addresses.length) console.log(info.listen_host.startsWith('127.') ? 'Local access only; set host to 0.0.0.0 for ESP32.' : 'No LAN IPv4 detected. Connect this PC to the same network as the ESP32 and refresh /connect.');
    for (const entry of info.addresses) {
      console.log(`LAN (${entry.interface}): ${entry.dashboard_url}`);
      console.log(`ESP32 server address: ${entry.device_api_url}`);
    }
    console.log('LAN clients are read-only. Candidate addresses do not confirm device connectivity.');
  });
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  // Internal launcher lifecycle only; no HTTP shutdown endpoint is exposed.
  if (process.send) {
    process.on('message', async raw => {
      const message = raw as Record<string, unknown> | null;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'focusdesk-stop') { void stop(); return; }
      if (!['focusdesk-import-preview', 'focusdesk-import-commit'].includes(String(message.type))) return;
      const responseType = message.type === 'focusdesk-import-preview' ? 'focusdesk-import-preview' : 'focusdesk-import-result';
      if (stopping) { notify({ type: responseType, requestId: message.requestId, ok: false, code: 'IMPORT_SERVICE_STOPPING' }); return; }
      try {
        const source = validateDesktopSource(message.source);
        if (message.type === 'focusdesk-import-preview') {
          const current = await loader.load();
          const now = Date.now();
          const focusActive = !!source.focus && Date.parse(source.focus.started_at) <= now && now < Date.parse(source.focus.ends_at);
          notify({ type: responseType, requestId: message.requestId, ok: true, revision: current.revision, exists: true, taskCount: source.tasks.length, focusActive });
        } else {
          await loader.importSource(source, { revision: message.revision as string, confirmed: message.confirmed === true, backupsPath: message.backupsPath as string });
          notify({ type: responseType, requestId: message.requestId, ok: true, code: 'IMPORT_OK' });
        }
      } catch (error) {
        const code = error instanceof ImportSourceError ? error.code : error instanceof RevisionConflictError ? 'IMPORT_REVISION_CONFLICT' : error instanceof SourceError ? 'IMPORT_SOURCE_UNAVAILABLE' : 'IMPORT_FAILED';
        notify({ type: responseType, requestId: message.requestId, ok: false, code });
      }
    });
    process.on('disconnect', () => { void stop(); });
    // A host can disappear while async configuration/locking is still in
    // progress, before this listener exists. Do not leave that child running.
    if (!process.connected) void stop();
  }
  }
} catch (error) {
  notify({ type: 'focusdesk-error', code: startupStage });
  console.error(error instanceof Error ? error.message : 'Invalid startup options.');
  process.exitCode = 1;
  if (dataLock) await dataLock.release();
  if (process.connected) process.disconnect();
}
