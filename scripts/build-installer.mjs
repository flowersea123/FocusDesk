import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TOOL_CACHE, ensureInnoTool, ensureNodeRuntime, fileSha256,
  INNO_TOOL, NODE_RUNTIME, regularFile, runProcess,
} from './fetch-runtime.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXED_FILES = [
  'backend/server.ts',
  'scripts/desktop-host.mjs', 'scripts/desktop-logs.mjs', 'scripts/desktop-paths.mjs',
  'scripts/import-client.mjs', 'docs/WINDOWS_DESKTOP.md',
];
const TREES = ['backend/src','backend/public','frontend/dist'];
const FRONTEND_LICENSES = ['react','react-dom','scheduler'].map(name => ({
  source: `frontend/node_modules/${name}/LICENSE`, target: `licenses/${name}.LICENSE.txt`,
}));
FRONTEND_LICENSES.push({ source: 'contracts/DISPLAY_FONT_LICENSE.txt', target: 'licenses/DISPLAY_FONT_LICENSE.txt' });
const EXCLUDED = new Set(['node_modules','.git','.cache','data','fixtures','firmware','tests','test','__tests__','coverage','test-results','playwright-report']);

export function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function excluded(name) {
  const lower = name.toLowerCase();
  return EXCLUDED.has(lower) || lower === 'private_config.h' || lower === '.env' ||
    lower.startsWith('.env.') || lower.endsWith('.local') || lower.endsWith('.log') ||
    lower.endsWith('.map') || /\.(?:test|spec)\.[^.]+$/i.test(name);
}
async function collectTree(root, relative, files) {
  const directory = path.join(root, relative);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a source directory: ${relative}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${child}`);
    if (entry.isDirectory()) await collectTree(root, child, files);
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported source entry: ${child}`);
  }
}
export async function collectPayloadSources(projectRoot = ROOT) {
  const files = [...FIXED_FILES];
  for (const relative of files) await regularFile(path.join(projectRoot, relative));
  for (const item of FRONTEND_LICENSES) await regularFile(path.join(projectRoot,item.source));
  await regularFile(path.join(projectRoot, 'frontend/dist/index.html'));
  for (const relative of TREES) await collectTree(projectRoot, relative, files);
  for (const entry of await readdir(path.join(projectRoot, 'contracts'), { withFileTypes: true })) {
    if (!entry.name.endsWith('.ts') || excluded(entry.name)) continue;
    const relative = path.join('contracts', entry.name);
    await regularFile(path.join(projectRoot, relative)); files.push(relative);
  }
  return [...new Set(files)].sort();
}

export async function stagePayload({ projectRoot = ROOT, destination, runtime, launcher, version }) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(destination);
  for (const source of [...TREES, 'contracts','scripts','launcher','installer','docs','backend/data']) {
    if (within(path.join(root, source), target)) throw new Error('Staging must be outside source directories.');
  }
  if (process.env.LOCALAPPDATA && within(path.join(process.env.LOCALAPPDATA,'FocusDesk'),target))
    throw new Error('Staging cannot be user data.');
  const files = await collectPayloadSources(root);
  await regularFile(runtime.executable); await regularFile(runtime.license); await regularFile(launcher);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target); // Exclusive directory: never merge with an existing staging or user data.
  async function copy(source, relative) {
    const filename = path.join(target, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await copyFile(source, filename, constants.COPYFILE_EXCL);
  }
  for (const relative of files) await copy(path.join(root, relative), relative);
  for (const item of FRONTEND_LICENSES) await copy(path.join(root,item.source),item.target);
  await copy(runtime.executable, 'runtime/node.exe');
  await copy(runtime.license, 'runtime/LICENSE');
  await copy(launcher, 'launcher/FocusDesk.exe');
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'focusdesk', version, private: true, type: 'module' }, null, 2) + '\n', { flag: 'wx' });
  const payloadFiles = [...files, ...FRONTEND_LICENSES.map(item=>item.target),
    'runtime/node.exe','runtime/LICENSE','launcher/FocusDesk.exe','package.json'].sort();
  const manifest = [];
  for (const relative of payloadFiles) {
    const filename = path.join(target, relative);
    manifest.push({ path: relative.split(path.sep).join('/'), bytes: (await lstat(filename)).size,
      sha256: await fileSha256(filename) });
  }
  return { directory: target, files: manifest };
}

export async function compileLauncher({ projectRoot = ROOT, output, compiler = 'C:\\Program Files\\mingw64\\bin\\g++.exe' }) {
  await regularFile(path.join(projectRoot, 'launcher/FocusDesk.cpp'));
  await mkdir(path.dirname(output), { recursive: true });
  const args = ['-municode','-mwindows','-std=c++17','-static','-static-libgcc','-static-libstdc++','-pthread',
    path.join(projectRoot,'launcher/FocusDesk.cpp'), '-o', output,
    '-luser32','-lshell32','-lole32','-lcomdlg32','-ladvapi32'];
  await runProcess(compiler, args, { cwd: projectRoot });
  await regularFile(output);
  return { output, compiler, arguments: args, sourceSha256: await fileSha256(path.join(projectRoot,'launcher/FocusDesk.cpp')) };
}

export async function buildInstaller({ projectRoot = ROOT, output, cacheDir = DEFAULT_TOOL_CACHE,
                                      testUserDataDir, testAppVersion, compiler } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows installer builds require Windows.');
  if (testAppVersion && !testUserDataDir) throw new Error('A test app version requires isolated test user data.');
  const root = path.resolve(projectRoot);
  const destination = path.resolve(root, output ?? '.cache/m1-dist/FocusDesk-Setup.exe');
  if (path.basename(destination).toLowerCase() !== 'focusdesk-setup.exe')
    throw new Error('Installer output filename must be FocusDesk-Setup.exe.');
  for (const source of [...TREES,'contracts','scripts','launcher','installer','docs','backend/data'])
    if (within(path.join(root, source), destination)) throw new Error('Installer output must be outside source and data directories.');
  const localData = process.env.LOCALAPPDATA;
  if (localData && within(path.join(localData,'FocusDesk'), destination)) throw new Error('Installer output cannot be user data.');
  const metadata = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const version = testAppVersion ?? metadata.version;
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Installer requires a numeric app version.');
  await collectPayloadSources(root);
  const runtime = await ensureNodeRuntime({ cacheDir });
  const inno = await ensureInnoTool({ cacheDir });
  const work = path.join(root, '.cache/m1-builds', `${Date.now()}-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  const native = await compileLauncher({ projectRoot: root, output: path.join(work,'build/FocusDesk.exe'), compiler });
  const payload = await stagePayload({ projectRoot: root, destination: path.join(work,'payload'),
    runtime, launcher: native.output, version });
  const outputDir = path.join(work, 'installer-output');
  await mkdir(outputDir);
  const args = [`/DStageDir=${payload.directory}`,`/DOutputDir=${outputDir}`,`/DAppVersion=${version}`];
  if (testUserDataDir) {
    const directory = path.resolve(testUserDataDir);
    if (/["'\r\n]/.test(directory)) throw new Error('Unsupported test data path characters.');
    args.push(`/DM1TestUserDataDir=${directory}`,
      `/DTestBuildId=${createHash('sha256').update(directory).digest('hex').slice(0,16)}`);
  }
  args.push(path.join(root,'installer/FocusDesk.iss'));
  await runProcess(inno.compiler, args, { cwd: root, timeout: 300000 });
  const built = path.join(outputDir,'FocusDesk-Setup.exe');
  await regularFile(built);
  const manifest = {
    format: 1, app: 'FocusDesk', version, builtAt: new Date().toISOString(),
    platform: 'win32', architecture: 'x64', testBuild: Boolean(testUserDataDir),
    runtime: { ...runtime, directory: undefined, executable: undefined, license: undefined },
    toolchain: { innoVersion: INNO_TOOL.version, innoSetupSha256: INNO_TOOL.sha256,
      innoCompilerSha256: inno.compilerSha256, launcherSourceSha256: native.sourceSha256,
      launcherCompiler: path.basename(native.compiler),
      installerScriptSha256: await fileSha256(path.join(root,'installer/FocusDesk.iss')),
      buildScriptSha256: await fileSha256(fileURLToPath(import.meta.url)),
      runtimeLockSha256: await fileSha256(path.join(root,'installer/runtime-lock.json')) },
    payload: payload.files, installerSha256: await fileSha256(built),
    installerBytes: (await lstat(built)).size,
  };
  await writeFile(path.join(work,'build-manifest.json'), JSON.stringify(manifest,null,2)+'\n', { flag:'wx' });
  await mkdir(path.dirname(destination), { recursive:true });
  const manifestPath = `${destination}.manifest.json`;
  for (const filename of [destination,manifestPath]) {
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing non-file installer output.');
      if (!within(path.join(root,'.cache'),filename)) throw new Error('Refusing to replace an existing custom output.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const pending = `${destination}.tmp-${randomUUID()}`;
  const pendingManifest = `${manifestPath}.tmp-${randomUUID()}`;
  try {
    await copyFile(built,pending,constants.COPYFILE_EXCL);
    await writeFile(pendingManifest,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    await rename(pending,destination);
    await rename(pendingManifest,manifestPath);
  } finally {
    await unlink(pending).catch(()=>undefined);
    await unlink(pendingManifest).catch(()=>undefined);
  }
  return { output:destination, manifest:manifestPath, staging:payload.directory,
    version, files:payload.files.length, sha256:manifest.installerSha256, testBuild:manifest.testBuild };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  if (args.includes('--help')) {
    console.log('Usage: node scripts/build-installer.mjs [--output PATH/FocusDesk-Setup.exe] [--test-user-data-dir PATH] [--test-app-version X.Y.Z] [--compiler PATH]');
    return;
  }
  for (let i=0;i<args.length;i+=2) {
    if (!args[i+1]) throw new Error('Missing build option value.');
    if (args[i]==='--output') options.output=args[i+1];
    else if (args[i]==='--test-user-data-dir') options.testUserDataDir=args[i+1];
    else if (args[i]==='--test-app-version') options.testAppVersion=args[i+1];
    else if (args[i]==='--compiler') options.compiler=args[i+1];
    else throw new Error(`Unknown build option: ${args[i]}`);
  }
  console.log(JSON.stringify(await buildInstaller(options),null,2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error=>{ console.error(error.message); process.exitCode=1; });
