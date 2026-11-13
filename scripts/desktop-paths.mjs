import path from 'node:path';

export function desktopPaths(appRoot, userRoot = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'FocusDesk')) {
  if (!userRoot) throw new Error('USER_DATA_UNAVAILABLE');
  const root = path.resolve(appRoot), user = path.resolve(userRoot);
  return {
    appRoot: root, userRoot: user,
    runtime: path.join(root, 'runtime', 'node.exe'),
    backend: path.join(root, 'backend', 'server.ts'),
    dist: path.join(root, 'frontend', 'dist'),
    dataPath: path.join(user, 'data', 'tasks.json'),
    configPath: path.join(user, 'config', 'focusdesk.config.json'),
    logsPath: path.join(user, 'logs'), backupsPath: path.join(user, 'backups'),
  };
}
