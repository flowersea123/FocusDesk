import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageLan } from '../../scripts/package-lan.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SEED = {
  schema_version: '1.0', revision: 'synthetic-seed', date: '2026-11-03', timezone: 'UTC',
  updated_at: '2026-11-03T00:00:00Z',
  tasks: [{ id: 'synthetic-1', title: 'Synthetic portable task', status: 'todo', due_at: null }],
  focus: { task_id: 'synthetic-1', started_at: '2026-11-03T00:00:00.000Z', ends_at: '2026-11-03T00:25:00.000Z' },
};

async function put(root, relative, content) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function fixture(t, { build = true } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'FocusDesk 便携测试 '));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    const parent = path.resolve(tmpdir());
    const relative = path.relative(parent, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(resolved).startsWith('FocusDesk 便携测试 ')) throw new Error('Unsafe temporary cleanup path');
    await rm(resolved, { recursive: true, force: true });
  });
  const project = path.join(temporary, '源项目 with spaces');
  const files = {
    'package.json': JSON.stringify({ name: 'portable-test', type: 'module', engines: { node: '>=24' }, scripts: { start: 'node scripts/start-focusdesk.mjs' } }),
    'focusdesk.config.json': JSON.stringify({ host: '0.0.0.0', port: 8787 }),
    'Start FocusDesk.cmd': '@echo off\r\nnode "%~dp0scripts\\start-focusdesk.mjs"\r\n',
    'scripts/start-focusdesk.mjs': "import '../backend/server.ts';\n",
    'docs/WINDOWS_LAN.md': '# Portable Windows usage\nNode.js 24 is required.\n',
    'backend/server.ts': "import { readSeed } from './src/runtime.ts';\nconsole.log('PORTABLE_READY ' + readSeed());\n",
    'backend/src/runtime.ts': "import { readFileSync } from 'node:fs';\nimport { SCHEMA_VERSION } from '../../contracts/daily-overview.ts';\nexport function readSeed(): string { const source = JSON.parse(readFileSync(new URL('../data/tasks.json', import.meta.url), 'utf8')); return SCHEMA_VERSION + ' ' + source.tasks[0].title; }\n",
    'backend/public/connect.html': '<!doctype html><title>Connect</title>',
    'backend/public/assets/connect.css': 'body { color: #333; }',
    'backend/data/tasks.json': JSON.stringify({ date: '2026-11-03', timezone: 'UTC', tasks: [{ id: 'private', title: 'PERSONAL_PRIVATE_TASK', status: 'todo', due_at: null }] }),
    'contracts/fixtures/device-demo.json': JSON.stringify(SEED),
    'contracts/DISPLAY_FONT_LICENSE.txt': 'Synthetic fixture license for bundled display font data.\n',
    'contracts/fixtures/today.json': 'PERSONAL_PRIVATE_FIXTURE',
    'backend/tests/private.test.mjs': 'PERSONAL_PRIVATE_TEST',
    'backend/src/tests/nested.test.ts': 'PERSONAL_PRIVATE_NESTED_TEST',
    'backend/src/helper.test.ts': 'PERSONAL_PRIVATE_TEST_MODULE',
    'backend/src/private_config.h': 'PERSONAL_PRIVATE_DEVICE_SECRET',
    'backend/public/.env.local': 'PERSONAL_PRIVATE_ENV',
    'backend/public/.cache/state': 'PERSONAL_PRIVATE_CACHE',
    'contracts/runtime.test.ts': 'PERSONAL_PRIVATE_CONTRACT_TEST',
    'firmware/private_config.h': 'PERSONAL_PRIVATE_FIRMWARE',
    'node_modules/private-package/index.js': 'PERSONAL_PRIVATE_DEV_DEPENDENCY',
    '.env': 'PERSONAL_PRIVATE_ROOT_ENV',
  };
  if (build) {
    files['frontend/dist/index.html'] = '<!doctype html><title>FocusDesk</title><script src="/assets/app.js"></script>';
    files['frontend/dist/assets/app.js'] = 'console.log("dashboard");';
    files['frontend/dist/.env'] = 'PERSONAL_PRIVATE_DIST_ENV';
  }
  for (const [relative, content] of Object.entries(files)) await put(project, relative, content);
  for (const filename of ['daily-overview.ts', 'work-state.ts', 'ai-suggestion.ts', 'display-snapshot.ts', 'display-fonts.ts']) {
    await copyFile(path.join(ROOT, 'contracts', filename), path.join(project, 'contracts', filename));
  }
  return { temporary, project, output: path.join(temporary, '输出 Portable LAN') };
}

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relative));
    else result.push(relative.split(path.sep).join('/'));
  }
  return result.sort();
}

test('exports only the runtime and synthetic seed, preserving personal source data', async t => {
  const { project, output } = await fixture(t);
  const personalBefore = await readFile(path.join(project, 'backend/data/tasks.json'), 'utf8');
  const result = await packageLan({ projectRoot: project, output });
  assert.equal(result.output, output);
  const files = await listFiles(output);
  assert.deepEqual(files, [
    'Start FocusDesk.cmd', 'backend/data/tasks.json', 'backend/public/assets/connect.css',
    'backend/public/connect.html', 'backend/server.ts', 'backend/src/runtime.ts',
    'contracts/DISPLAY_FONT_LICENSE.txt', 'contracts/ai-suggestion.ts', 'contracts/daily-overview.ts', 'contracts/display-fonts.ts',
    'contracts/display-snapshot.ts', 'contracts/work-state.ts', 'docs/WINDOWS_LAN.md', 'focusdesk.config.json',
    'frontend/dist/assets/app.js', 'frontend/dist/index.html', 'package.json', 'scripts/start-focusdesk.mjs',
  ].sort());
  assert.equal(result.files, files.length);
  const seed = JSON.parse(await readFile(path.join(output, 'backend/data/tasks.json'), 'utf8'));
  assert.deepEqual(seed, { date: SEED.date, timezone: SEED.timezone, tasks: SEED.tasks });
  assert.equal('focus' in seed, false);
  for (const relative of files) assert.doesNotMatch(await readFile(path.join(output, relative), 'utf8'), /PERSONAL_PRIVATE/);
  assert.equal(await readFile(path.join(project, 'backend/data/tasks.json'), 'utf8'), personalBefore);
});

test('exported runtime starts from an unrelated cwd without npm or development dependencies', async t => {
  const { project, output, temporary } = await fixture(t);
  await packageLan({ projectRoot: project, output });
  const result = spawnSync(process.execPath, [path.join(output, 'scripts/start-focusdesk.mjs')], {
    cwd: temporary, encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /PORTABLE_READY 1\.0 Synthetic portable task/);
});

test('refuses an existing output directory without replacing its files', async t => {
  const { project, output } = await fixture(t);
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'keep this unknown file');
  await assert.rejects(packageLan({ projectRoot: project, output }), /already exists/);
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'keep this unknown file');
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('a missing UI build fails before creating a partial output', async t => {
  const { project, output } = await fixture(t, { build: false });
  await assert.rejects(packageLan({ projectRoot: project, output }), /build before packaging/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('missing startup files fail before creating the output', async t => {
  const { project, output } = await fixture(t);
  await rm(path.join(project, 'scripts/start-focusdesk.mjs'));
  await assert.rejects(packageLan({ projectRoot: project, output }), { code: 'ENOENT' });
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('rejects an invalid synthetic seed before creating the output', async t => {
  const { project, output } = await fixture(t);
  await put(project, 'contracts/fixtures/device-demo.json', JSON.stringify({ ...SEED, tasks: [{ ...SEED.tasks[0], title: '私有中文' }] }));
  await assert.rejects(packageLan({ projectRoot: project, output }), /ASCII/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('CLI locates the project from its own path and exports to a Chinese/spaced output path', async t => {
  const { project, output, temporary } = await fixture(t);
  const script = path.join(project, 'scripts/package-lan.mjs');
  await copyFile(path.join(ROOT, 'scripts/package-lan.mjs'), script);
  const result = spawnSync(process.execPath, [script, '--output', output], { cwd: temporary, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /portable directory/);
  assert.equal(JSON.parse(await readFile(path.join(output, 'backend/data/tasks.json'), 'utf8')).tasks[0].title, 'Synthetic portable task');
  assert.equal((await listFiles(output)).includes('scripts/package-lan.mjs'), false);
});

test('CLI default output is inside its project root and existing output is refused', async t => {
  const { project, temporary } = await fixture(t);
  const script = path.join(project, 'scripts/package-lan.mjs');
  await copyFile(path.join(ROOT, 'scripts/package-lan.mjs'), script);
  const result = spawnSync(process.execPath, [script], { cwd: temporary, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const target = path.join(project, '.cache/releases/FocusDesk-LAN');
  assert.ok((await listFiles(target)).includes('Start FocusDesk.cmd'));
  const again = spawnSync(process.execPath, [script], { cwd: temporary, encoding: 'utf8', timeout: 10_000 });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test('rejects outputs inside copied source trees without modifying the build', async t => {
  const { project } = await fixture(t);
  const output = path.join(project, 'frontend/dist/export');
  await assert.rejects(packageLan({ projectRoot: project, output }), /outside the source runtime/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
  assert.match(await readFile(path.join(project, 'frontend/dist/index.html'), 'utf8'), /FocusDesk/);
});
