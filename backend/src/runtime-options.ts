import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import path from 'node:path';

export async function loadRuntimeOptions(projectRoot: string, args: string[]) {
  const options = {
    host: '0.0.0.0', port: 8787,
    dataPath: path.join(projectRoot, 'backend', 'data', 'tasks.json'),
    distPath: path.join(projectRoot, 'frontend', 'dist'),
  };
  let configPath = path.join(projectRoot, 'focusdesk.config.json');
  let explicitConfig = false;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!value || !['--host', '--port', '--data', '--dist', '--config'].includes(name)) throw new Error('Usage: node backend/server.ts [--config path] [--host IPv4] [--port 8787] [--data path] [--dist path]');
    if (name === '--config') { configPath = path.resolve(value); explicitConfig = true; }
  }
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).some(key => key !== 'host' && key !== 'port')) throw new Error('Only host and port are supported.');
    config = parsed as Record<string, unknown>;
  } catch (error) {
    if (explicitConfig || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Could not read focusdesk.config.json. Use valid JSON containing host and port.');
    }
  }
  if (config.host !== undefined) {
    if (typeof config.host !== 'string' || !isIPv4(config.host)) throw new Error('focusdesk.config.json host must be an IPv4 address; use 0.0.0.0 for LAN access.');
    options.host = config.host;
  }
  if (config.port !== undefined) {
    if (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error('focusdesk.config.json port must be a number from 1 to 65535.');
    options.port = Number(config.port);
  }
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (name === '--config') continue;
    if (name === '--host') {
      if (!isIPv4(value)) throw new Error('--host must be an IPv4 address.');
      options.host = value;
    } else if (name === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('--port must be an integer from 1 to 65535.');
      options.port = Number(value);
    } else if (name === '--data') options.dataPath = path.resolve(value);
    else options.distPath = path.resolve(value);
  }
  return { ...options, configPath };
}
