import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const open = args.includes('--open');
const serverArgs = args.filter(value => value !== '--open');
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('FocusDesk needs Node.js 24 or newer. Update Node.js, then open Start FocusDesk.cmd again.');
  process.exitCode = 1;
} else {
  try {
    await access(path.join(root, 'frontend', 'dist', 'index.html'));
    const child = spawn(process.execPath, [path.join(root, 'backend', 'server.ts'), ...serverArgs], { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    let opened = false;
    child.on('message', message => {
      if (process.send && message?.type === 'focusdesk-ready') process.send(message);
      if (!open || opened || process.platform !== 'win32' || message?.type !== 'focusdesk-ready' || !message.connectionUrl) return;
      const url = new URL(message.connectionUrl);
      if (url.protocol !== 'http:' || !url.hostname.startsWith('127.')) return;
      opened = true;
      const browser = spawn('explorer.exe', [url.href], { stdio: 'ignore', windowsHide: true });
      browser.on('error', () => console.error(`Open this address in your browser: ${url.href}`));
      browser.unref();
    });
    // Windows delivers Ctrl+C to the console process group; the child handles
    // its own graceful shutdown. Forward SIGINT explicitly on POSIX.
    process.on('SIGINT', () => { if (process.platform !== 'win32') child.kill('SIGINT'); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); });
    const stop = () => { if (child.connected) child.send({ type: 'focusdesk-stop' }); };
    if (process.send) { process.on('message', message => { if (message?.type === 'focusdesk-stop') stop(); }); process.on('disconnect', stop); }
    child.on('error', error => { console.error(`FocusDesk could not start: ${error.message}`); process.exitCode = 1; });
    child.on('exit', (code, reason) => { process.exitCode = code ?? (reason ? 1 : 0); if (process.connected) process.disconnect(); });
  } catch {
    console.error('FocusDesk Dashboard files are missing. Use the complete portable folder. For a source checkout, run npm run build first.');
    process.exitCode = 1;
  }
}
