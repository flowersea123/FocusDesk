import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDailyOverview } from '../contracts/daily-overview.ts';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED_FILES = [
  'backend/server.ts', 'package.json', 'focusdesk.config.json',
  'Start FocusDesk.cmd', 'scripts/start-focusdesk.mjs', 'docs/WINDOWS_LAN.md',
  'contracts/DISPLAY_FONT_LICENSE.txt',
];
const RUNTIME_TREES = ['backend/src', 'backend/public', 'frontend/dist'];
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.cache', '.git', 'firmware', 'tests', 'test', '__tests__', '__pycache__', 'coverage']);

function excluded(name) {
  const normalized = name.toLowerCase();
  return EXCLUDED_DIRECTORIES.has(normalized) || normalized === 'private_config.h' ||
    normalized === '.env' || normalized.startsWith('.env.') ||
    /\.(?:pyc|pyo|gguf|safetensors|eml|pem|key|pfx|p12|local|log|map)$/i.test(name) ||
    /\.(?:test|spec)\.[^.]+$/i.test(name);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function requireFile(filename) {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Expected a regular file: ${filename}`);
}

async function collectTree(root, relative, files) {
  const directory = path.join(root, relative);
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a regular directory: ${directory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be exported: ${child}`);
    if (entry.isDirectory()) await collectTree(root, child, files);
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported source entry: ${child}`);
  }
}

/** Export an existing UI build and Node 24 runtime; never overwrite a destination. */
export async function packageLan({ projectRoot = PROJECT_ROOT, output } = {}) {
  const root = path.resolve(projectRoot);
  const destination = path.resolve(root, output ?? '.cache/releases/FocusDesk-LAN');
  try {
    await lstat(destination);
    throw new Error(`Output already exists; choose a new --output path: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (RUNTIME_TREES.some(relative => within(path.join(root, relative), destination))) {
    throw new Error('Output must be outside the source runtime directories.');
  }

  // Complete source checks before creating the output, including the UI entry point.
  const files = [...REQUIRED_FILES];
  try { await requireFile(path.join(root, 'frontend/dist/index.html')); }
  catch (error) { throw new Error('Missing frontend/dist/index.html. Run the project build before packaging.', { cause: error }); }
  for (const relative of REQUIRED_FILES) await requireFile(path.join(root, relative));
  for (const relative of RUNTIME_TREES) await collectTree(root, relative, files);
  const contracts = await readdir(path.join(root, 'contracts'), { withFileTypes: true });
  for (const entry of contracts) {
    if (!entry.name.endsWith('.ts') || excluded(entry.name)) continue;
    const relative = path.join('contracts', entry.name);
    await requireFile(path.join(root, relative));
    files.push(relative);
  }
  const seedPath = path.join(root, 'contracts/fixtures/device-demo.json');
  await requireFile(seedPath);
  const seed = parseDailyOverview(JSON.parse(await readFile(seedPath, 'utf8')));
  if (seed.tasks.some(task => !/^[\x20-\x7e]{1,40}$/.test(task.title))) {
    throw new Error('Portable seed must contain printable ASCII device-demo titles.');
  }
  const demoData = `${JSON.stringify({ date: seed.date, timezone: seed.timezone, tasks: seed.tasks }, null, 2)}\n`;
  const taskRelative = path.join('backend', 'data', 'tasks.json');
  const directories = new Set();
  for (const relative of [...files, taskRelative]) {
    let parent = path.dirname(relative);
    while (parent !== '.') { directories.add(parent); parent = path.dirname(parent); }
  }

  await mkdir(path.dirname(destination), { recursive: true });
  // Exclusive root and file creation prevents merging with or replacing another export.
  await mkdir(destination);
  const createdDirectories = [destination];
  const createdFiles = [];
  try {
    for (const relative of [...directories].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))) {
      const directory = path.join(destination, relative);
      await mkdir(directory);
      createdDirectories.push(directory);
    }
    for (const relative of [...files, taskRelative]) {
      const filename = path.join(destination, relative);
      const handle = await open(filename, 'wx');
      createdFiles.push(filename);
      try {
        const content = relative === taskRelative ? demoData : await readFile(path.join(root, relative));
        await handle.writeFile(content);
      } finally { await handle.close(); }
    }
    return { output: destination, files: createdFiles.length };
  } catch (error) {
    // Remove only entries created by this invocation; never recursively delete unknown data.
    for (const filename of createdFiles.reverse()) await unlink(filename).catch(() => undefined);
    for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/package-lan.mjs [--output PATH]\nRequires a prebuilt frontend/dist and Node.js 24+. Relative output paths use the project root.');
    return;
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--'))) {
    throw new Error('Usage: node scripts/package-lan.mjs [--output PATH]');
  }
  const result = await packageLan({ output: args[1] });
  console.log(`FocusDesk portable directory: ${result.output}\n${result.files} files exported. Target PC requires Node.js 24+; no npm install is needed.\nOpen Start FocusDesk.cmd. Existing personal tasks and private device configuration were not copied.`);
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
