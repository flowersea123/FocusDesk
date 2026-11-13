import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildInstaller, collectPayloadSources, stagePayload } from '../../scripts/build-installer.mjs';
import { sha256 } from '../../scripts/fetch-runtime.mjs';

async function fixture(t) {
  const temporary=await mkdtemp(path.join(os.tmpdir(),'focusdesk-installer-build-'));
  t.after(async()=>{
    if(path.dirname(path.resolve(temporary))!==path.resolve(os.tmpdir()) ||
      !path.basename(temporary).startsWith('focusdesk-installer-build-'))throw new Error('Unsafe test cleanup');
    await rm(temporary,{recursive:true,force:true});
  });
  const root=path.join(temporary,'source');
  const required=['backend/server.ts','backend/src/service.ts','backend/public/connect.html',
    'frontend/dist/index.html','frontend/dist/assets/app.js','contracts/daily-overview.ts','contracts/task-update.ts',
    'contracts/focus-update.ts','contracts/work-state.ts','contracts/display-snapshot.ts','contracts/display-fonts.ts',
    'scripts/desktop-host.mjs','scripts/desktop-logs.mjs','scripts/desktop-paths.mjs','scripts/import-client.mjs',
    'docs/WINDOWS_DESKTOP.md'];
  const traps=['backend/data/tasks.json','backend/src/.env','frontend/dist/private_config.h',
    'frontend/dist/.env.production','frontend/dist/assets/app.js.map','frontend/dist/node_modules/secret.txt',
    'contracts/fixtures/personal.json','firmware/focusdesk_live/private_config.h','config/personal.json'];
  for(const filename of [...required,...traps]) {
    await mkdir(path.dirname(path.join(root,filename)),{recursive:true});
    await writeFile(path.join(root,filename),traps.includes(filename)?'PRIVATE_TEST_SENTINEL':filename);
  }
  for(const name of ['react','react-dom','scheduler']) {
    const filename=path.join(root,'frontend/node_modules',name,'LICENSE');
    await mkdir(path.dirname(filename),{recursive:true}); await writeFile(filename,`${name} MIT LICENSE`);
  }
  await writeFile(path.join(root,'contracts/DISPLAY_FONT_LICENSE.txt'),'DISPLAY FONT LICENSE FIXTURE');
  const runtime={executable:path.join(temporary,'node.exe'),license:path.join(temporary,'LICENSE')};
  const launcher=path.join(temporary,'FocusDesk.exe');
  await writeFile(runtime.executable,'TEST_RUNTIME'); await writeFile(runtime.license,'TEST_LICENSE');
  await writeFile(launcher,'TEST_LAUNCHER');
  return {temporary,root,required,traps,runtime,launcher};
}
test('payload source whitelist includes runtime modules and excludes data/private/dev files',async t=>{
  const f=await fixture(t), sources=(await collectPayloadSources(f.root)).map(p=>p.split(path.sep).join('/'));
  assert.deepEqual(sources.sort(),[...f.required].sort());
  for(const trap of f.traps) assert(!sources.includes(trap));
  assert.equal(await readFile(path.join(f.root,'backend/data/tasks.json'),'utf8'),'PRIVATE_TEST_SENTINEL');
});
test('new staging contains only approved files, runtime license and native launcher with hashes',async t=>{
  const f=await fixture(t), destination=path.join(f.temporary,'fresh payload 中文');
  const payload=await stagePayload({projectRoot:f.root,destination,runtime:f.runtime,launcher:f.launcher,version:'0.1.0'});
  assert.equal(payload.files.length,f.required.length+8);
  assert.equal(JSON.parse(await readFile(path.join(destination,'package.json'),'utf8')).type,'module');
  assert.equal(await readFile(path.join(destination,'runtime/LICENSE'),'utf8'),'TEST_LICENSE');
  assert.equal(await readFile(path.join(destination,'licenses/react.LICENSE.txt'),'utf8'),'react MIT LICENSE');
  assert.equal(await readFile(path.join(destination,'licenses/DISPLAY_FONT_LICENSE.txt'),'utf8'),'DISPLAY FONT LICENSE FIXTURE');
  const fontLicense=payload.files.find(item=>item.path==='licenses/DISPLAY_FONT_LICENSE.txt');
  assert.equal(fontLicense.sha256,sha256(Buffer.from('DISPLAY FONT LICENSE FIXTURE')));
  assert(!payload.files.some(item=>item.path.includes('node_modules')));
  const runtimeFile=payload.files.find(item=>item.path==='runtime/node.exe');
  assert.equal(runtimeFile.sha256,sha256(Buffer.from('TEST_RUNTIME')));
  await assert.rejects(access(path.join(destination,'backend/data/tasks.json')));
  await assert.rejects(stagePayload({projectRoot:f.root,destination,runtime:f.runtime,launcher:f.launcher,version:'0.1.0'}),/EEXIST/);
  assert.equal(await readFile(path.join(destination,'runtime/node.exe'),'utf8'),'TEST_RUNTIME');
});
test('missing built UI fails before creating staging',async t=>{
  const f=await fixture(t), destination=path.join(f.temporary,'no output');
  await rm(path.join(f.root,'frontend/dist/index.html'));
  await assert.rejects(stagePayload({projectRoot:f.root,destination,runtime:f.runtime,launcher:f.launcher,version:'0.1.0'}),/ENOENT/);
  await assert.rejects(access(destination));
});

test('missing display font license fails before creating staging',async t=>{
  const f=await fixture(t), destination=path.join(f.temporary,'no font license output');
  await rm(path.join(f.root,'contracts/DISPLAY_FONT_LICENSE.txt'));
  await assert.rejects(stagePayload({projectRoot:f.root,destination,runtime:f.runtime,launcher:f.launcher,version:'0.1.0'}),/ENOENT/);
  await assert.rejects(access(destination));
});
test('staging refuses runtime source and backend data directories',async t=>{
  const f=await fixture(t);
  for(const child of ['backend/src/new','frontend/dist/new','contracts/new','backend/data/new'])
    await assert.rejects(stagePayload({projectRoot:f.root,destination:path.join(f.root,child),runtime:f.runtime,launcher:f.launcher,version:'0.1.0'}),/outside source/);
});
test('source junctions are refused rather than exported',async t=>{
  const f=await fixture(t), outside=path.join(f.temporary,'outside');
  await mkdir(outside); await writeFile(path.join(outside,'hidden.txt'),'PRIVATE_TEST_SENTINEL');
  await symlink(outside,path.join(f.root,'frontend/dist/leak'),'junction');
  await assert.rejects(collectPayloadSources(f.root),/symlink/);
});
test('Inno uses per-user installation, graceful wait and no user-data removal section',async()=>{
  const source=await readFile(new URL('../../installer/FocusDesk.iss',import.meta.url),'utf8');
  assert.match(source,/PrivilegesRequired=lowest/);
  assert.match(source,/DefaultDirName=\{localappdata\}\\Programs\\FocusDesk/);
  assert.match(source,/ewWaitUntilTerminated/);
  assert.match(source,/function PrepareToInstall/);
  assert.match(source,/function InitializeUninstall/);
  assert.match(source,/CloseApplications=no/);
  assert.doesNotMatch(source,/^\[UninstallDelete\]/m);
  assert.doesNotMatch(source,/^\[Registry\]/m);
  assert.doesNotMatch(source,/Name: "desktopicon"[^\n]*Flags: unchecked/);
});
test('app version overrides are refused for normal release builds',async()=>{
  await assert.rejects(buildInstaller({testAppVersion:'0.1.1'}),/requires isolated test user data/);
});
