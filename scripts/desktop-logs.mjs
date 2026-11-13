import { mkdirSync, statSync, renameSync, unlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['code', 'exitCode', 'signal', 'port', 'version', 'runtime', 'pid']);
export function createDesktopLogger(directory, { maxBytes = 128 * 1024, archives = 3 } = {}) {
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'focusdesk.log');
  return (event, details = {}) => {
    const safe = {};
    for (const [key, value] of Object.entries(details)) {
      if (ALLOWED.has(key) && (typeof value === 'number' || (typeof value === 'string' && /^[\w.+:-]{0,80}$/.test(value)))) safe[key] = value;
    }
    const line = JSON.stringify({ time: new Date().toISOString(), event: /^[A-Z_]{1,64}$/.test(event) ? event : 'APPLICATION_EVENT', ...safe }) + '\n';
    try {
      let size = 0; try { size = statSync(filename).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        try { unlinkSync(filename + '.' + archives); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (let i = archives - 1; i >= 1; i--) {
          try { renameSync(filename + '.' + i, filename + '.' + (i + 1)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        try { renameSync(filename, filename + '.1'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      appendFileSync(filename, line, { mode: 0o600 });
      return true;
    } catch { return false; }
  };
}
