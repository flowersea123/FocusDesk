import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lock from '../installer/runtime-lock.json' with { type: 'json' };

export const NODE_RUNTIME = Object.freeze(lock.node);
export const INNO_TOOL = Object.freeze(lock.inno);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_TOOL_CACHE = path.join(ROOT, '.cache/m1-toolchain');

export function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
export async function fileSha256(filename) { return sha256(await readFile(filename)); }
export async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${filename}`);
}

export function checkOfficialNodeSums(text) {
  const line = text.split(/\r?\n/).find(item => item.endsWith(`  ${NODE_RUNTIME.archive}`));
  if (!line || line.slice(0, 64).toLowerCase() !== NODE_RUNTIME.sha256 ||
      !/^[a-f0-9]{64}  \S+$/.test(line)) {
    throw new Error('Official Node checksum does not match the pinned release; refusing download.');
  }
  return NODE_RUNTIME.sha256;
}

export async function runProcess(command, args, { env = process.env, cwd = ROOT, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2 * 1024 * 1024); });
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} failed (${code ?? signal}): ${stderr || stdout}`));
    });
  });
}

export async function verifiedDownload({ url, filename, expectedSha256, fetchImpl = fetch }) {
  try {
    await regularFile(filename);
    if (await fileSha256(filename) !== expectedSha256) throw new Error(`Cached SHA-256 mismatch: ${filename}`);
    return filename;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${randomUUID()}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Official download failed: HTTP ${response.status}`);
  const writer = await open(temporary, 'wx');
  const digest = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > 128 * 1024 * 1024) throw new Error('Official artifact exceeds download limit.');
      digest.update(chunk);
      await writer.writeFile(chunk);
    }
    await writer.close();
    if (digest.digest('hex') !== expectedSha256) throw new Error('Official artifact SHA-256 mismatch.');
    try { await copyFile(temporary, filename, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST' || await fileSha256(filename) !== expectedSha256) throw error;
    }
    return filename;
  } finally {
    await writer.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function ensureChecksumFile(cacheDir, fetchImpl) {
  const filename = path.join(cacheDir, 'downloads/SHASUMS256-node-v24.16.0.txt');
  try { const text = await readFile(filename, 'utf8'); checkOfficialNodeSums(text); return text; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(NODE_RUNTIME.checksumsUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Node checksum download failed: HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 65536) throw new Error('Node checksum manifest is unexpectedly large.');
  checkOfficialNodeSums(text);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, text, { flag: 'wx' });
  return text;
}

export async function ensureNodeRuntime({ cacheDir = DEFAULT_TOOL_CACHE, fetchImpl = fetch } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows runtime extraction requires Windows.');
  cacheDir = path.resolve(cacheDir);
  await ensureChecksumFile(cacheDir, fetchImpl);
  const archive = await verifiedDownload({ url: NODE_RUNTIME.url,
    filename: path.join(cacheDir, 'downloads', NODE_RUNTIME.archive),
    expectedSha256: NODE_RUNTIME.sha256, fetchImpl });
  const runtimeDir = path.join(cacheDir, `node-v${NODE_RUNTIME.version}-win-x64`);
  const executable = path.join(runtimeDir, 'node.exe');
  const license = path.join(runtimeDir, 'LICENSE');
  try {
    await regularFile(executable); await regularFile(license);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const staging = `${runtimeDir}.extract-${randomUUID()}`;
    await mkdir(staging);
    try {
      // Extract exactly two known entries from the checksum-verified official zip.
      const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `$z=[IO.Compression.ZipFile]::OpenRead($env:FD_NODE_ARCHIVE); try { ` +
        `foreach($name in @('node.exe','LICENSE')) { ` +
        `$entry=$z.GetEntry('node-v24.16.0-win-x64/'+$name); if(-not $entry){throw 'Missing official Node entry'}; ` +
        `[IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $env:FD_NODE_DESTINATION $name),$false) } ` +
        `} finally {$z.Dispose()}`;
      await runProcess('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
        env: { ...process.env, FD_NODE_ARCHIVE: archive, FD_NODE_DESTINATION: staging },
      });
      if (await fileSha256(path.join(staging, 'node.exe')) !== NODE_RUNTIME.executableSha256)
        throw new Error('Extracted official node.exe hash mismatch.');
      await rename(staging, runtimeDir);
    } catch (error) {
      // Only exact files created by this extraction, never source/user directories.
      await unlink(path.join(staging, 'node.exe')).catch(() => undefined);
      await unlink(path.join(staging, 'LICENSE')).catch(() => undefined);
      const { rmdir } = await import('node:fs/promises');
      await rmdir(staging).catch(() => undefined);
      throw error;
    }
  }
  if (await fileSha256(executable) !== NODE_RUNTIME.executableSha256)
    throw new Error('Runtime node.exe does not match the pinned official release.');
  if (await fileSha256(license) !== NODE_RUNTIME.licenseSha256)
    throw new Error('Runtime LICENSE does not match the pinned official release.');
  const { stdout } = await runProcess(executable, ['-p', "process.version+' '+process.platform+' '+process.arch"]);
  if (stdout.trim() !== 'v24.16.0 win32 x64') throw new Error('Extracted runtime version/architecture mismatch.');
  return { directory: runtimeDir, executable, license,
    archiveSha256: NODE_RUNTIME.sha256, executableSha256: NODE_RUNTIME.executableSha256,
    licenseSha256: await fileSha256(license), version: NODE_RUNTIME.version,
    url: NODE_RUNTIME.url, checksumsUrl: NODE_RUNTIME.checksumsUrl };
}

export async function ensureInnoTool({ cacheDir = DEFAULT_TOOL_CACHE, fetchImpl = fetch } = {}) {
  if (process.platform !== 'win32') throw new Error('Inno Setup compilation requires Windows.');
  cacheDir = path.resolve(cacheDir);
  const setup = await verifiedDownload({ url: INNO_TOOL.url,
    filename: path.join(cacheDir, 'downloads', INNO_TOOL.archive),
    expectedSha256: INNO_TOOL.sha256, fetchImpl });
  const directory = path.join(cacheDir, `inno-${INNO_TOOL.version}`);
  const compiler = path.join(directory, 'ISCC.exe');
  try { await regularFile(compiler); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Official setup.iss/isportable.iss: /PORTABLE=1 disables uninstall registration,
    // previous installation lookup, shortcuts and file association changes.
    const script = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:FD_INNO_SETUP ` +
      `-ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/CURRENTUSER','/PORTABLE=1',('/DIR="'+$env:FD_INNO_DESTINATION+'"')) ` +
      `-WindowStyle Hidden -PassThru -Wait; if($p.ExitCode -ne 0){exit $p.ExitCode}`;
    await runProcess('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
      env: { ...process.env, FD_INNO_SETUP: setup, FD_INNO_DESTINATION: directory },
    });
  }
  await regularFile(compiler);
  if (await fileSha256(compiler) !== INNO_TOOL.compilerSha256)
    throw new Error('Cached Inno compiler does not match the verified official portable release.');
  return { directory, compiler, version: INNO_TOOL.version, url: INNO_TOOL.url,
    setupSha256: INNO_TOOL.sha256, compilerSha256: await fileSha256(compiler) };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--with-inno'))
    throw new Error('Usage: node scripts/fetch-runtime.mjs [--with-inno]');
  const runtime = await ensureNodeRuntime();
  console.log(JSON.stringify({ runtime,
    ...(process.argv.includes('--with-inno') ? { inno: await ensureInnoTool() } : {}) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
