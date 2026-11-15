import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const shim = path.join(root, 'tests/firmware/mac-host');
const cache = path.join(root, '.cache/display-host');
const dependencyDirectory = path.join(cache, 'dependencies');
const lock = JSON.parse(await readFile(path.join(shim, 'upstream-gfx.json'), 'utf8'));
const compiler = process.env.CXX || 'clang++';
const flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let runDirectory;
const report = {
  status: 'running', started_at: new Date().toISOString(), platform: process.platform,
  architecture: process.arch, node: process.version, dependency: lock,
  renderer: 'unmodified Adafruit_GFX.cpp + FocusDesk parser, fonts and panel driver',
  steps: [], inputs: [], suites: [],
  limits: ['No ESP32 instruction emulation', 'No physical Wi-Fi, NVS, SPI or panel',
    'No target firmware build, upload, serial access, power or timing measurement'],
};

function run(label, command, args, { print = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  report.steps.push({ label, command, args, exit_code: result.status,
    stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message });
  if (result.error || result.status !== 0) {
    const hint = result.error?.code === 'ENOENT' && command === compiler
      ? ' Install Apple Command Line Tools (xcode-select --install), or set CXX to an existing C++ compiler path.'
      : '';
    throw new Error(`${label} failed.${hint}\n${result.error?.message || result.stderr || result.stdout || `Exit ${result.status}`}`);
  }
  if (print && result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout || '';
}

async function archiveBytes(archive) {
  try { return await readFile(archive); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`Downloading official Adafruit GFX ${lock.version} (once; project cache only)...`);
  let bytes;
  try {
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Source archive exceeds the 2 MiB download limit');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } catch (error) {
    throw new Error(`Could not download ${lock.url}: ${error.message}. Check network access, or place the verified archive at ${archive}. See docs/firmware/HOST_SIMULATION.md.`);
  }
  if (sha256(bytes) !== lock.sha256) throw new Error('Downloaded Adafruit GFX archive does not match the pinned SHA-256; refusing to extract it.');
  const temporary = `${archive}.${process.pid}.part`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, archive); }
  finally { await rm(temporary, { force: true }); }
  return bytes;
}

async function recordInputs() {
  const sourceFiles = [
    'scripts/test-display-host.mjs', 'scripts/check-display-parity.mjs',
    'contracts/display-snapshot.ts', 'contracts/display-fonts.ts', 'contracts/project-progress.ts',
    'contracts/fixtures/device-demo.json', 'contracts/fixtures/focus.json',
    'tests/firmware/v02_snapshot_test.cpp', 'tests/firmware/device_sync_test.cpp',
    'tests/firmware/live_fakes/Arduino.h', 'tests/firmware/live_fakes/SPI.h',
    'firmware/focusdesk_device/display_snapshot.h', 'firmware/focusdesk_device/display_sync.h',
    'firmware/focusdesk_live/live_model.h', 'firmware/focusdesk_live/live_state.h',
    'firmware/focusdesk_live/config.h', 'firmware/focusdesk_live/gdem042f52_display.h',
    'firmware/focusdesk_live/gdem042f52_display.cpp', 'firmware/focusdesk_live/src/ArduinoJson.h',
    ...['logic_test', 'config_store_test', 'config_session_test', 'hub_validation_test']
      .map(name => `tests/provisioning/${name}.cpp`),
    ...['poc_logic', 'config_store', 'config_session', 'hub_validation']
      .map(name => `firmware/experiments/focusdesk_provisioning_poc/${name}.h`),
  ];
  for (const directory of ['tests/firmware/mac-host', 'firmware/focusdesk_device/fonts']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isFile()) sourceFiles.push(`${directory}/${entry.name}`);
    }
  }
  for (const file of sourceFiles.sort()) {
    report.inputs.push({ file, sha256: sha256(await readFile(path.join(root, file))) });
  }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required for the shared TypeScript layout.');
  if (process.argv.length > 2) throw new Error('Usage: node scripts/test-display-host.mjs (optional CXX environment variable selects the compiler).');
  await mkdir(path.join(cache, 'runs'), { recursive: true });
  await mkdir(dependencyDirectory, { recursive: true });
  runDirectory = await mkdtemp(path.join(cache, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  report.compiler = run('C++ compiler availability', compiler, ['--version'], { print: false }).split('\n')[0];
  await recordInputs();

  const archive = path.join(dependencyDirectory, `Adafruit-GFX-${lock.version}.tar.gz`);
  const bytes = await archiveBytes(archive);
  if (sha256(bytes) !== lock.sha256) {
    throw new Error(`Cached archive SHA-256 mismatch: ${archive}. Remove that archive and retry; extracted sources were not used.`);
  }
  const vendorParent = path.join(runDirectory, 'vendor');
  await mkdir(vendorParent);
  run('Extract verified GFX archive', 'tar', ['-xzf', archive, '-C', vendorParent], { print: false });
  const vendor = path.join(vendorParent, lock.directory);
  const properties = await readFile(path.join(vendor, 'library.properties'), 'utf8');
  if (!properties.split(/\r?\n/).includes(`version=${lock.version}`)) throw new Error('Extracted GFX library version does not match the dependency lock.');
  report.dependency_license = { file: path.relative(root, path.join(vendor, lock.license)),
    sha256: sha256(await readFile(path.join(vendor, lock.license))) };

  const includes = ['-I', shim, '-I', path.join(root, 'tests/firmware/live_fakes'), '-I', vendor];
  const gfxObject = path.join(runDirectory, 'upstream-gfx.o');
  console.log(`Compiling official GFX ${lock.version} and the existing firmware snapshot test...`);
  run('Compile upstream GFX', compiler, [...flags, ...includes, '-DARDUINO=100',
    '-DAdafruit_GFX=FocusDeskUpstreamGFX', '-c', path.join(vendor, 'Adafruit_GFX.cpp'), '-o', gfxObject]);
  const renderer = path.join(runDirectory, 'snapshot-renderer');
  run('Compile firmware snapshot renderer', compiler, [...flags, ...includes,
    `-DFOCUSDESK_UPSTREAM_GFX_HEADER="${path.join(vendor, 'Adafruit_GFX.h')}"`,
    path.join(root, 'tests/firmware/v02_snapshot_test.cpp'),
    path.join(root, 'firmware/focusdesk_live/gdem042f52_display.cpp'), gfxObject, '-o', renderer]);
  const snapshotOutput = run('Snapshot parser and native renderer checks', renderer, []);
  const snapshotChecks = snapshotOutput.match(/PASS: (\d+) V0\.2 snapshot checks/);
  if (!snapshotChecks) throw new Error('Snapshot test did not report its completed check count.');
  report.suites.push({ name: 'snapshot', checks: Number(snapshotChecks[1]) });

  const parityDirectory = path.join(runDirectory, 'parity');
  run('Shared layout versus native firmware pixels', process.execPath,
    [path.join(root, 'scripts/check-display-parity.mjs'), renderer, parityDirectory]);
  report.parity = JSON.parse(await readFile(path.join(parityDirectory, 'result.json'), 'utf8'));
  if (!report.parity.matched || report.parity.pixelsPerCase !== 120000 || !report.parity.cases.length) {
    throw new Error('Pixel comparison did not produce a complete matching report.');
  }

  for (const [name, source] of [
    ['provisioning', 'tests/provisioning/logic_test.cpp'],
    ['configuration-store', 'tests/provisioning/config_store_test.cpp'],
    ['configuration-session', 'tests/provisioning/config_session_test.cpp'],
    ['hub-validation', 'tests/provisioning/hub_validation_test.cpp'],
    ['display-sync', 'tests/firmware/device_sync_test.cpp'],
  ]) {
    const executable = path.join(runDirectory, name);
    run(`Compile ${name}`, compiler, [...flags, path.join(root, source), '-o', executable]);
    const output = run(`${name} checks`, executable, []);
    const count = output.match(/checks passed: (\d+)/);
    if (!count) throw new Error(`${name} did not report its completed check count.`);
    report.suites.push({ name, checks: Number(count[1]) });
  }
  // A concurrent edit must not make the recorded source hashes describe a
  // different build from the one tested.
  for (const input of report.inputs) {
    if (sha256(await readFile(path.join(root, input.file))) !== input.sha256) {
      throw new Error(`Source changed during checks: ${input.file}. Rerun after the edit completes.`);
    }
  }
  report.status = 'passed';
  report.total_checks = report.suites.reduce((sum, suite) => sum + suite.checks, 0);
  console.log(`PASS: ${report.total_checks} native checks; ${report.parity.cases.length} scenes × ${report.parity.pixelsPerCase} identical pixels.`);
  console.log('Hardware behavior, electrical signals and ESP32 firmware execution are not simulated.');
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  console.error(`Display host verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (runDirectory) {
    report.finished_at = new Date().toISOString();
    const resultFile = path.join(runDirectory, 'result.json');
    await writeFile(resultFile, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(cache, 'latest.json'), `${JSON.stringify({ status: report.status, result: resultFile }, null, 2)}\n`);
    console.log(`Verification record: ${resultFile}`);
  }
}
