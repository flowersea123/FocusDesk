import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { connectForegroundHelper, foregroundSupport } from '../src/foreground-platform/index.ts';

const frame = {image:'data:image/jpeg;base64,/9j/2Q==', app:'Example Reader', pageTitle:'Chapter One', windowId:'42/21'};
function helper(operation) {
  return spawn(process.execPath,['-e',`
    const readline=require('node:readline');
    const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');
    const frame=${JSON.stringify(frame)};
    send({type:'ready'});
    let count=0;
    readline.createInterface({input:process.stdin}).on('line', line=>{
      if (line!=='capture') process.exit(4);
      count++;
      ${operation}
    });
  `],{stdio:'pipe'});
}

test('maps foreground pages across title changes, bounds visible titles and discards native identifiers', async t => {
  const child = helper("send({type:'frame',frame:{...frame,pageTitle:(count===1?'A':'B').repeat(180)}});");
  const control = new AbortController();
  let notifications = 0;
  const session = await connectForegroundHelper(child,{signal:control.signal,onStop:()=>notifications++});
  t.after(()=>session.close());
  const first = await session.capture(control.signal), second = await session.capture(control.signal);
  assert.equal(first.pageTitle.length,160);
  assert.deepEqual(Object.keys(first).sort(), ['app','image','pageKey','pageTitle']);
  assert.match(first.pageKey,/^[a-f0-9]{64}$/);
  assert.notEqual(first.pageKey,second.pageKey);
  await session.close(); await session.close();
  assert.equal(notifications,0); assert.notEqual(child.signalCode,null);
  assert.equal(await session.capture(control.signal),null);
});

test('a native Stop action or closed indicator ends the session and notifies the recorder once', async () => {
  const child = helper("send({type:'stopped'});");
  const control = new AbortController();
  let calls = 0, cleaned=0;
  const session = await connectForegroundHelper(child,{signal:control.signal,onStop:()=>calls++},async()=>{cleaned++;});
  await assert.rejects(session.capture(control.signal), /录制窗口已关闭/);
  await session.close();
  assert.equal(calls,1); assert.equal(cleaned,1);
});

test('a late frame cannot escape cancellation and no duplicate sample runs while a native call blocks', async () => {
  const child = helper("setTimeout(()=>send({type:'frame',frame}),5000);");
  const owner = new AbortController(), shot = new AbortController();
  let stops=0;
  const session=await connectForegroundHelper(child,{signal:owner.signal,onStop:()=>stops++});
  const pending=session.capture(shot.signal);
  assert.equal(await session.capture(owner.signal),null);
  shot.abort();
  await assert.rejects(pending,/取消/);
  await session.close();
  assert.equal(stops,1); assert.notEqual(child.signalCode,null);
});

test('aborting before the native indicator becomes ready kills its process without a frame', async () => {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'pipe'});
  const closed=once(child,'close');
  const owner=new AbortController();
  const pending=connectForegroundHelper(child,{signal:owner.signal,onStop:()=>assert.fail('unexpected native stop')});
  owner.abort(); await assert.rejects(pending,/停止/); await closed;
});

test('unsupported sessions return a noninteractive support message', async () => {
  if (process.platform==='win32' || (process.platform==='linux' && process.env.XDG_SESSION_TYPE==='x11')) return;
  const info=await foregroundSupport();
  assert.equal(info.supported,false); assert.equal(typeof info.message,'string');
});

test('rejects malformed native images and carries the stop reason to the recorder', async () => {
  const child=helper("send({type:'frame',frame:{...frame,image:'data:image/jpeg;base64,/9j/broken'}});");
  const source=new AbortController();
  let reason;
  const session=await connectForegroundHelper(child,{signal:source.signal,onStop:value=>{reason=value;}});
  await assert.rejects(session.capture(source.signal),/响应无效/);
  assert.equal(reason,'前台窗口响应无效。');
  await session.close();
});

test('ignores frames from interactive-unsupported Wayland and remote X11 without starting a desktop helper', async () => {
  const module = new URL('../src/foreground-platform/index.ts',import.meta.url).href;
  for (const env of [{DISPLAY:':0',XDG_SESSION_TYPE:'wayland'}, {DISPLAY:'remote.example:0',XDG_SESSION_TYPE:'x11'}]) {
    const script = "Object.defineProperty(process,'platform',{value:'linux'});" +
      "const {foregroundSupport}=await import("+JSON.stringify(module)+");console.log(JSON.stringify(await foregroundSupport()));";
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env, ...env, WAYLAND_DISPLAY:'',PATH:''}});
    let stdout='';child.stdout.on('data',data=>{stdout+=data;});
    assert.equal((await once(child,'close'))[0],0);
    assert.match(JSON.parse(stdout).message,/Wayland、远程 X11/);
    assert.equal(JSON.parse(stdout).supported,false);
  }
});
