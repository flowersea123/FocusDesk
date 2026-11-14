import { access, copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRuntimeOptions } from '../backend/src/runtime-options.ts';
import { validateDesktopSource } from '../backend/src/desktop-data.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'npm run dev -- [--port 8787] [--ui-port 5173] [--data path] [--open] [--no-watch]';

export function parseDevelopmentOptions(args) {
  const result = { uiPort: 5173, watch: true, open: false };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--open') { result.open = true; continue; }
    if (key === '--no-watch') { result.watch = false; continue; }
    if (!['--port', '--ui-port', '--data'].includes(key) || !args[index + 1]) throw new Error(usage);
    const value = args[++index];
    if (key === '--data') result.dataPath = path.resolve(value);
    else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Ports must be integers from 1 to 65535.');
      result[key === '--port' ? 'port' : 'uiPort'] = Number(value);
    }
  }
  return result;
}

/** Seed a fresh checkout once. Never replace an existing task file, even if invalid. */
export async function prepareDevelopmentData(root, dataPath) {
  await mkdir(path.dirname(dataPath), { recursive: true });
  try {
    await copyFile(path.join(root, 'backend/data/tasks.example.json'), dataPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const bytes = await readFile(dataPath);
  validateDesktopSource(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  if (child.connected) child.send({ type: 'focusdesk-stop' }, () => undefined);
  else child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 4_000);
  try { await ended; } finally { clearTimeout(force); }
}

/** Real backend plus Vite's development UI; neither uses a separate mock data store. */
export async function startDevelopment(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('FocusDesk development requires Node.js 24 or newer.');
  const root = path.resolve(options.root ?? projectRoot);
  const configured = await loadRuntimeOptions(root, []);
  const port = options.port ?? configured.port;
  const uiPort = options.uiPort ?? 5173;
  if (port === uiPort) throw new Error('Hub and Dashboard development ports must be different.');
  const dataPath = path.resolve(options.dataPath ?? configured.dataPath);
  const viteModule = path.join(root, 'frontend/node_modules/vite/dist/node/index.js');
  try { await access(viteModule); }
  catch { throw new Error('Install the frontend dependencies first: npm --prefix frontend ci'); }
  await prepareDevelopmentData(root, dataPath);

  const backendUrl = `http://127.0.0.1:${port}`;
  const dashboardUrl = `http://127.0.0.1:${uiPort}/`;
  let backend;
  let ui;
  let stopped = false;
  let closing;
  let restartTimer;
  let restartChain = Promise.resolve();
  const watchers = [];
  const intentionalStops = new WeakSet();

  async function launchBackend() {
    const child = spawn(process.execPath, [path.join(root, 'backend/server.ts'),
      '--host', '127.0.0.1', '--port', String(port), '--data', dataPath], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    backend = child;
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    let ready = false;
    child.on('exit', () => {
      if (ready && !stopped && !intentionalStops.has(child)) console.error('FocusDesk Hub stopped. Save a backend source file to retry, or restart npm run dev.');
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('FocusDesk Hub did not become ready. Check its startup output.')), 10_000);
      const error = failure => finish(failure);
      const exit = code => finish(new Error(`FocusDesk Hub exited before becoming ready (${code}).`));
      const message = value => {
        if (value?.type === 'focusdesk-ready') { ready = true; finish(); }
        else if (value?.type === 'focusdesk-error') finish(new Error(`FocusDesk Hub could not start: ${value.code}`));
      };
      function finish(failure) {
        clearTimeout(timeout);
        child.off('error', error); child.off('exit', exit); child.off('message', message);
        if (failure) reject(failure); else resolve();
      }
      child.once('error', error); child.once('exit', exit); child.on('message', message);
    });
  }

  function close() {
    if (closing) return closing;
    stopped = true;
    clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    closing = (async () => {
      if (backend) intentionalStops.add(backend);
      await Promise.all([stopBackend(backend), ui?.close()]);
      await restartChain;
    })();
    return closing;
  }

  function scheduleRestart() {
    if (stopped) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartChain = restartChain.then(async () => {
        if (stopped) return;
        if (backend) intentionalStops.add(backend);
        await stopBackend(backend);
        if (stopped) return;
        try {
          await launchBackend();
          if (!stopped) ui.ws.send({ type: 'full-reload', path: '*' });
        } catch (error) {
          if (!stopped) console.error(`Hub reload failed: ${error.message}\nFix the source and save again to retry.`);
        }
      }).catch(error => { if (!stopped) console.error(`Hub reload failed: ${error.message}`); });
    }, 180);
  }

  try {
    await launchBackend();
    const { createServer } = await import(pathToFileURL(viteModule).href);
    ui = await createServer({
      root: path.join(root, 'frontend'), configFile: path.join(root, 'frontend/vite.config.ts'),
      cacheDir: path.resolve(options.cacheDir ?? process.env.FOCUSDESK_DEV_CACHE_DIR ?? path.join(root, '.cache/vite-development')),
      // Publish optimized dependencies without waiting for the entire initial
      // crawl, so an early shutdown can settle in-flight module requests.
      optimizeDeps: { holdUntilCrawlEnd: false },
      define: { 'import.meta.env.VITE_DATA_SOURCE': JSON.stringify('http'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
      server: { host: '127.0.0.1', port: uiPort, strictPort: true, preTransformRequests: false,
        proxy: { '/api': { target: backendUrl, changeOrigin: false }, '/connect': { target: backendUrl, changeOrigin: false } } },
    });
    await ui.listen();
    if (options.watch !== false) {
      for (const name of ['backend', 'contracts']) {
        const watcher = watch(path.join(root, name), { recursive: true }, (_event, filename) => {
          const relative = String(filename ?? '').replaceAll('\\', '/');
          if (relative.endsWith('.ts') && !relative.includes('/tests/') &&
              (name === 'contracts' || relative === 'server.ts' || relative.startsWith('src/'))) scheduleRestart();
        });
        watcher.on('error', error => console.error(`Source watcher stopped: ${error.message}. Restart npm run dev after code changes.`));
        watchers.push(watcher);
      }
    }
    return { close, dashboardUrl, simulatorUrl: dashboardUrl + 'simulator', backendUrl, dataPath };
  } catch (error) { await close(); throw error; }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.error(`Open this address in a browser: ${url}`));
  child.unref();
}

async function main() {
  if (process.argv.includes('--help')) { console.log(usage); return; }
  let running;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    if (running) void running.close().finally(() => { if (process.connected) process.disconnect(); });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (process.send) {
    process.on('disconnect', stop);
    process.on('message', message => { if (message?.type === 'focusdesk-stop') stop(); });
  }
  try {
    const options = parseDevelopmentOptions(process.argv.slice(2));
    running = await startDevelopment(options);
    if (interrupted || (process.send && !process.connected)) { await running.close(); return; }
    console.log(`\nFocusDesk development is ready.\nDashboard: ${running.dashboardUrl}\nDevice simulator: ${running.simulatorUrl}\nLocal Hub: ${running.backendUrl}\nData: ${running.dataPath}\nCtrl+C stops the UI and Hub. Save drafts before changing backend/layout source files; those changes reload the page.\n`);
    if (process.connected) process.send({ type: 'focusdesk-dev-ready', ...running, close: undefined }, () => undefined);
    if (options.open) openBrowser(running.dashboardUrl);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
    if (running) await running.close();
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) await main();
