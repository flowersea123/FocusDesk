// macOS 14.4+, Node 24+, Command Line Tools. No desktop capture permission is requested.
// Run: node scripts/bench-capture-memory.mjs. JSON measurements go into .cache/capture-memory/.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createForegroundRecorder } from '../backend/src/foreground-recorder.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(root, '.cache/capture-memory');
const binary = join(cache, 'fixture');
const cases = [
  { name: 'one-every-four-seconds', windows: 1, period: 4000, rounds: 12 },
  { name: 'one-every-second', windows: 1, period: 1000, rounds: 24 },
  { name: 'four-every-second', windows: 4, period: 1000, rounds: 24 },
  { name: 'four-window-accelerated', windows: 4, period: 250, rounds: 100 },
  { name: 'four-retain-every-frame', windows: 4, period: 1000, rounds: 24, retain: true },
];
const gc = async () => { global.gc(); await delay(25); global.gc(); };
async function scenario(spec) {
  const child = spawn(binary, [String(spec.windows)], {stdio: ['pipe','pipe','inherit']});
  const ended = once(child,'exit');
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity})[Symbol.asyncIterator]();
  async function read() {
    const result = await lines.next();
    if (result.done) throw Error('Synthetic capture helper exited before replying');
    const row = JSON.parse(result.value);
    if (row.error) throw Error(row.error);
    return row;
  }
  async function command(value) { child.stdin.write(String(value) + '\n'); return read(); }
  const limit = spec.rounds * spec.windows;
  const measurements = [], retained = [];
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  let recorder;
  try {
    const initial = await read();
    if (!initial.ready) throw Error('Fixture setup failed');
    // Warm up framework caches and every synthetic surface before measuring.
    for (let i = 0; i < 4 * spec.windows; i++) await command(i % spec.windows);
    await gc();
    const nativeBase = (await command('memory')).native;
    const nodeBase = process.memoryUsage();
    const start = performance.now();
    let captured = 0, analyzed = 0, saved = 0, failure;
    const captureErrors = [];
    recorder = createForegroundRecorder({
      platform:'darwin', support: async () => ({supported:true, message:''}), pollMs:0,
      open: async () => ({
        async capture(signal) {
          if (captured === limit) {
            finish(); await delay(60_000, undefined, {signal}); return null;
          }
          const round = Math.floor(captured / spec.windows), window = captured % spec.windows;
          const wait = start + round * spec.period - performance.now();
          if (wait > 0) await delay(wait, undefined, {signal});
          try {
            let row;
            for (let attempt = 0; attempt < 3; attempt++) {
              try { row = await command(window); break; }
              catch (error) {
                captureErrors.push({ atFrame:captured+1, message:error.message });
                if (attempt === 2) throw error;
                await delay(300, undefined, {signal});
              }
            }
            // Production transports a base64 data URI through JSON; exercise its decode/round-trip too.
            const payload = row.image.slice(23);
            const decoded = Buffer.from(payload,'base64');
            if (decoded.length > 1_048_576 || decoded.toString('base64') !== payload) throw Error('Bad JPEG');
            if (spec.retain) retained.push(row.image);
            captured++;
            measurements.push({frame: captured, elapsedMs:Math.round(performance.now()-start),
              jpegBytes:decoded.length, uriChars:row.image.length, native:row.native, node:process.memoryUsage(),
              width:row.width, height:row.height, bytesPerRow:row.bytesPerRow, captureEncodeMs:row.ms});
            return {image:row.image, app:'Synthetic',pageKey:'fixture-'+window,pageTitle:'Synthetic fixture'};
          } catch (error) { failure=error; finish(); throw error; }
        }, close() {},
      }),
      async analyze(_image, signal) {
        // Controlled latency; there is no inference model or model allocation in this benchmark.
        analyzed++; await delay(450,undefined,{signal});
        return {taskId:null,summary:'Synthetic observation',nextStep:'',progress:null,completedParts:[]};
      },
      async save() { saved++; },
    });
    recorder.start();
    await complete;
    if (failure) {
      await writeFile(join(cache, spec.name + '-incomplete.json'), JSON.stringify({spec,captureErrors,measurements},null,2));
      throw failure;
    }
    await recorder.close();
    await gc();
    const nodeEnd = process.memoryUsage(), nativeEnd = (await command('memory')).native;
    const retainedChars = retained.reduce((sum,s) => sum+s.length,0);
    retained.length=0;
    await gc();
    const nodeReleased = process.memoryUsage();
    const result = {spec, initialNative:initial.native, nodeBase,nativeBase, nodeEnd,nativeEnd,nodeReleased,
      nodeProcessLifetimeMaxRSS:process.resourceUsage().maxRSS*1024, captured, analyzed,saved,retainedChars,captureErrors,measurements};
    await writeFile(join(cache,spec.name+'.json'),JSON.stringify(result,null,2));
    console.log(spec.name,'frames',captured,'retained base64 chars',retainedChars);
  } finally {
    await recorder?.close(); child.stdin.end(); await ended;
  }
}
async function summarize() {
  const mib = bytes => Math.round(bytes / 1_048_576 * 10) / 10;
  const results = [];
  for (const spec of cases) {
    const run = JSON.parse(await readFile(join(cache, spec.name + '.json'), 'utf8'));
    const rows = run.measurements, last = rows.at(-1);
    const bytes = rows.reduce((sum, row) => sum + row.jpegBytes, 0);
    results.push({
      case: spec.name, windows: spec.windows, eachWindowEveryMs: spec.period, frames: rows.length, captureErrors: run.captureErrors?.length ?? 0,
      firstToLastSeconds: (last.elapsedMs - rows[0].elapsedMs) / 1000,
      frameWidth: last.width, frameHeight: last.height, rawMiB: mib(last.height * last.bytesPerRow),
      meanJpegKiB: Math.round(bytes / rows.length / 1024 * 10) / 10, totalJpegMiB: mib(bytes),
      captureEncodeMeanMs: Math.round(rows.reduce((sum,row) => sum + row.captureEncodeMs,0) / rows.length * 10) / 10,
      nodeWarmRssMiB: mib(run.nodeBase.rss), nodeLifetimePeakRssMiB: mib(run.nodeProcessLifetimeMaxRSS),
      nodeAfterStopGcRssMiB: mib(run.nodeEnd.rss), nodeAfterStopGcHeapMiB: mib(run.nodeEnd.heapUsed),
      nodeAfterDroppingRetainedRssMiB: mib(run.nodeReleased.rss), nodeAfterDroppingRetainedHeapMiB: mib(run.nodeReleased.heapUsed),
      retainedUriMiB: mib(run.retainedChars), nativeWarmRssMiB: mib(run.nativeBase.rss),
      nativeLastRssMiB: mib(run.nativeEnd.rss), nativeLifetimePeakRssMiB: mib(run.nativeEnd.maxRSS),
    });
  }
  const summary = { operatingSystem: execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
    architecture: process.arch, nodeVersion: process.version,
    protocol: 'Synthetic text and color grid; own windows only; 4 warm-up frames per window. Fresh processes per case. Full-size CGImage, production ScreenCaptureKit/JPEG and recorder queue, JSON transport, simulated 450 ms analysis. RSS high-water includes warm-up. Post-stop readings follow two explicit garbage collections. Excludes model, WindowServer, other processes. No images written to disk.',
    results };
  await writeFile(join(cache,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.table(results.map(row => ({case:row.case,frames:row.frames,meanJpegKiB:row.meanJpegKiB,nodePeakMiB:row.nodeLifetimePeakRssMiB,
    afterStopMiB:row.nodeAfterStopGcRssMiB, afterDiscardMiB:row.nodeAfterDroppingRetainedRssMiB})));
}
if (process.platform !== 'darwin') throw Error('This ScreenCaptureKit measurement requires macOS.');
if (process.argv[2] === '--summary') {
  await summarize();
} else if (process.argv[2] === '--one') {
  const spec=cases.find(item=>item.name===process.argv[3]);
  if (!spec) throw Error('Unknown scenario');
  await scenario(spec);
} else {
  await mkdir(cache,{recursive:true});
  execFileSync('xcrun',['--sdk','macosx','swiftc','-swift-version','5','-O','-D','FOCUSDESK_CAPTURE_FIXTURES',
    '-module-cache-path',join(cache,'modules'),'-parse-as-library',join(root,'backend/src/foreground-mac/FocusDeskCapture.swift'),
    join(root,'scripts/bench-capture-memory.swift'),'-o',binary],{stdio:'inherit'});
  for (const spec of cases) execFileSync(process.execPath,['--expose-gc',resolve(process.argv[1]),'--one',spec.name],{stdio:'inherit',timeout:120000});
  await summarize();
}
