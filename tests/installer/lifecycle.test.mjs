import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildInstaller } from '../../scripts/build-installer.mjs';
import { runProcess } from '../../scripts/fetch-runtime.mjs';

const enabled=process.platform==='win32' && process.env.FOCUSDESK_RUN_INSTALLER_E2E==='1';
async function freePort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function waitFor(predicate,timeout=25000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    try { const result=await predicate(); if(result)return result; } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Timed out waiting for isolated installer lifecycle condition.');
}
async function waitExit(promise,message) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(message)),10000);
    })]);
  } finally { clearTimeout(timer); }
}

test('actual per-user install, 0.1.0 to 0.1.1 upgrade and running uninstall retain isolated user data',
  {skip:!enabled,timeout:240000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'focusdesk-installer-e2e-'));
  const app=path.join(temporary,'安装应用 with spaces');
  const user=path.join(temporary,'个人数据 with spaces');
  const launcher=path.join(app,'launcher/FocusDesk.exe');
  const uninstaller=path.join(app,'unins000.exe');
  let running=null, exitPromise=null, completed=false;
  const start=()=>{
    running=spawn(launcher,['--test-mode','--user-data-dir',user],{cwd:temporary,windowsHide:true,stdio:'ignore',
      env:{...process.env,PATH:'',NODE_PATH:'',NODE_OPTIONS:''}});
    exitPromise=new Promise((resolve,reject)=>{running.once('exit',(code,signal)=>resolve({code,signal}));running.once('error',reject);});
    return running.pid;
  };
  const waitReady=pid=>waitFor(async()=>{
    const state=JSON.parse(await readFile(path.join(user,'logs/test-state.json'),'utf8'));
    return state.pid===pid && state.phase==='ready' && state;
  });
  try {
    const result=await buildInstaller({output:path.join(temporary,'build-v1/FocusDesk-Setup.exe'),testUserDataDir:user,testAppVersion:'0.1.0'});
    assert.equal(result.testBuild,true);
    const manifest=JSON.parse(await readFile(result.manifest,'utf8'));
    assert.equal(manifest.testBuild,true);
    assert(!manifest.payload.some(item=>item.path.startsWith('backend/data/') || item.path.includes('private_config')));
    const installArgs=['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/NOICONS','/TASKS=!desktopicon',
      `/DIR=${app}`,`/LOG=${path.join(temporary,'install.log')}`];
    await runProcess(result.output,installArgs,{cwd:temporary});
    await access(launcher); await access(path.join(app,'runtime/node.exe')); await access(uninstaller);
    assert.equal(JSON.parse(await readFile(path.join(app,'package.json'),'utf8')).version,'0.1.0');
    await assert.rejects(access(path.join(app,'backend/data/tasks.json')));
    await mkdir(path.join(user,'config'),{recursive:true});
    await mkdir(path.join(user,'data'),{recursive:true});
    await mkdir(path.join(user,'backups'),{recursive:true});
    const port=await freePort();
    const config=JSON.stringify({host:'127.0.0.1',port});
    const source=JSON.stringify({date:'2026-11-03',timezone:'Asia/Shanghai',tasks:[
      {id:'installer-retain',title:'Keep my saved tasks',status:'todo',due_at:null},
    ]});
    const backup='ISOLATED_BACKUP_RETENTION_TEST';
    await writeFile(path.join(user,'config/focusdesk.config.json'),config);
    await writeFile(path.join(user,'data/tasks.json'),source);
    await writeFile(path.join(user,'backups/retention-test.json'),backup);
    const firstPid=start();
    await waitReady(firstPid);
    const response=await fetch(`http://127.0.0.1:${port}/api/v1/daily-overview`);
    assert.equal(response.status,200);
    assert.equal((await response.json()).tasks[0].title,'Keep my saved tasks');

    // A genuinely newer version, same isolated AppId and data directory.
    const upgrade=await buildInstaller({output:path.join(temporary,'build-v2/FocusDesk-Setup.exe'),testUserDataDir:user,testAppVersion:'0.1.1'});
    assert.equal(upgrade.version,'0.1.1');
    // Real setup's PrepareToInstall runs the installed launcher's --shutdown.
    await runProcess(upgrade.output,installArgs,{cwd:temporary});
    const firstExit=await waitExit(exitPromise,'Upgrade did not stop isolated launcher');
    assert.equal(firstExit.code,0);
    assert.equal(JSON.parse(await readFile(path.join(app,'package.json'),'utf8')).version,'0.1.1');
    assert.equal(await readFile(path.join(user,'config/focusdesk.config.json'),'utf8'),config);
    assert.equal(await readFile(path.join(user,'data/tasks.json'),'utf8'),source);
    assert.equal(await readFile(path.join(user,'backups/retention-test.json'),'utf8'),backup);
    const secondPid=start(); await waitReady(secondPid);
    assert.notEqual(firstPid,secondPid);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/v1/daily-overview`)).json()).tasks[0].id,'installer-retain');

    // Real InitializeUninstall stops the running instance before removing files.
    await runProcess(uninstaller,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',
      `/LOG=${path.join(temporary,'uninstall.log')}`],{cwd:temporary});
    const secondExit=await waitExit(exitPromise,'Uninstall did not stop isolated launcher');
    assert.equal(secondExit.code,0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/daily-overview`,{signal:AbortSignal.timeout(2000)}));
    await assert.rejects(access(launcher));
    assert.equal(await readFile(path.join(user,'config/focusdesk.config.json'),'utf8'),config);
    assert.equal(await readFile(path.join(user,'data/tasks.json'),'utf8'),source);
    assert.equal(await readFile(path.join(user,'backups/retention-test.json'),'utf8'),backup);
    await access(path.join(user,'logs'));
    completed=true;
    console.log('INSTALLER_E2E_OK: isolated Chinese/space paths, empty PATH, real 0.1.0 to 0.1.1 upgrade/uninstall, saved tasks/config/backups retained.');
  } finally {
    if(running && running.exitCode===null) {
      await runProcess(launcher,['--shutdown','--test-mode','--user-data-dir',user],{cwd:temporary,timeout:30000}).catch(()=>undefined);
      if(running.exitCode===null) running.kill(); // Only this test's own native child.
      await exitPromise?.catch(()=>undefined);
    }
    try { await access(uninstaller); await runProcess(uninstaller,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'],{cwd:temporary}); }
    catch {}
    if(path.dirname(path.resolve(temporary))!==path.resolve(os.tmpdir()) ||
       !path.basename(temporary).startsWith('focusdesk-installer-e2e-'))throw new Error('Unsafe test cleanup');
    if(completed) await rm(temporary,{recursive:true,force:true,maxRetries:12,retryDelay:250});
    else console.error(`Installer E2E diagnostics retained at ${temporary}`);
  }
});
