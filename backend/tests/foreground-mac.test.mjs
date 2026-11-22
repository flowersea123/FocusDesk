import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectForegroundHelper } from '../src/foreground-mac/ipc.ts';
import { foregroundSupport, openForegroundCapture } from '../src/foreground-mac/adapter.ts';
const run = promisify(execFile);
const unixSocket = {skip: process.platform === 'win32'};
const frame = {image:'data:image/jpeg;base64,/9j/4QAB/9k=',app:'Fixture Reader',pageKey:'e'.repeat(64),pageTitle:'First chapter'};

/** Test transport stands in for the menu-bar app. It never opens, reads, or grants access to another app. */
function fixture(receive, options={}) {
  let socket, path;
  const sent = message => socket.write(JSON.stringify(message)+'\n');
  const result = connectForegroundHelper(options, async socketPath => {
    path = socketPath;
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const secret = await readFile(join(dirname(path),'secret'),'utf8');
    socket = createConnection(path); socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error',()=>{});
    socket.on('data', data => {
      buffer += data; let i;
      while ((i=buffer.indexOf('\n')) >= 0) {
        const command = JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
        receive(command,sent,socket);
      }
    });
    await once(socket,'connect');sent({event:'hello',secret});
  });
  return { result, sent, path:()=>path };
}

test('local helper returns a window, skips an absent front window and removes the private session on close',unixSocket,async()=>{
  let requests=0, stops=0;
  const f=fixture((m,send)=>{
    if(m.op==='begin')send({event:'ready'});
    if(m.op==='capture')send({event:'frame',id:m.id,frame:++requests===1?frame:null});
  },{onStop:()=>stops++});
  const driver=await f.result;
  assert.deepEqual(await driver.capture(),frame);assert.equal(await driver.capture(),null);
  await Promise.all([driver.close(),driver.close()]);assert.equal(stops,0);
  await assert.rejects(access(dirname(f.path())),{code:'ENOENT'});
});
test('a startup permission denial retains the specific actionable message and does not call menu stop',unixSocket,async()=>{
  let stops=0;
  const msg='请在系统设置中允许 FocusDesk Capture，然后重新开始。';
  const f=fixture((m,send)=>{if(m.op==='begin')send({event:'error',code:'PERMISSION',message:msg});},{onStop:()=>stops++});
  await assert.rejects(f.result,{code:'PERMISSION',message:msg});assert.equal(stops,0);
});
test('a canceled frame and its late reply cannot leak into the next sampling period',unixSocket,async()=>{
  let first;const entered=Promise.withResolvers();
  const f=fixture((m,send)=>{
    if(m.op==='begin')send({event:'ready'});
    if(m.op==='capture' && !first){first=m.id;entered.resolve();}
    else if(m.op==='capture'){send({event:'frame',id:first,frame});send({event:'frame',id:m.id,frame:null});}
  });
  const d=await f.result;const abort=new AbortController();const pending=d.capture(abort.signal);
  await entered.promise;assert.equal(await d.capture(),null);abort.abort();await assert.rejects(pending,{code:'ABORTED'});
  assert.equal(await d.capture(),null);await d.close();
});
test('native menu stop or disconnect while sampling ends the session exactly once',unixSocket,async()=>{
  for(const action of ['stop','disconnect']){
    const reasons=[];
    const f=fixture((m,send,socket)=>{if(m.op==='begin')send({event:'ready'});
      if(m.op==='capture'){if(action==='stop')send({event:'stopped',code:'USER_STOP',message:'已从菜单栏停止'});else socket.end();}
    },{onStop:reason=>reasons.push(reason)});
    const d=await f.result;await assert.rejects(d.capture(),{code:action==='stop'?'USER_STOP':'HELPER_DISCONNECTED'});
    await d.close();assert.equal(reasons.length,1);if(action==='stop')assert.equal(reasons[0],'已从菜单栏停止');
  }
});
test('cancellation before launch starts no process; invalid image output stops a connected session',unixSocket,async()=>{
  const canceled=AbortSignal.abort();let launched=false;
  await assert.rejects(connectForegroundHelper({signal:canceled},async()=>{launched=true;}),{code:'ABORTED'});
  await assert.rejects(openForegroundCapture({signal:canceled}),{code:'ABORTED'});assert.equal(launched,false);
  const f=fixture((m,send)=>{if(m.op==='begin')send({event:'ready'});else if(m.op==='capture')send({event:'frame',id:m.id,frame:{...frame,image:'not a JPEG'}});});
  const driver=await f.result;await assert.rejects(driver.capture(),{code:'HELPER_DISCONNECTED'});await driver.close();
});
test('support detection is noninteractive and reports an unsupported operating system',async()=>{
  const support=await foregroundSupport();assert.equal(typeof support.message,'string');
  if(process.platform!=='darwin')assert.equal(support.supported,false);
});
test('the production selector rejects private and covered windows and changes keys on tab switches',{
  skip:process.platform!=='darwin',timeout:120_000,
},async t=>{
  if(!(await foregroundSupport()).supported){t.skip('macOS 14+ developer toolchain required');return;}
  try{await run('/usr/bin/xcode-select',['-p']);}catch{t.skip('No compiler installed');return;}
  const dir=await mkdtemp(join(tmpdir(),'focusdesk-selection-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const runner=join(dir,'Selection.swift');const exe=join(dir,'selection');
  await writeFile(runner,`import CoreGraphics
import Foundation
@main struct Selection { static func main() {
 func row(_ pid:Int,_ number:Int,_ title:String,_ layer:Int=0)->[String:Any] {
   [kCGWindowOwnerPID as String:pid,kCGWindowLayer as String:layer,kCGWindowIsOnscreen as String:true,
    kCGWindowAlpha as String:1,kCGWindowBounds as String:CGRect(x:0,y:0,width:500,height:300).dictionaryRepresentation,
    kCGWindowSharingState as String:1,kCGWindowNumber as String:number,kCGWindowName as String:title]
 }
 func pick(_ rows:[[String:Any]],_ app:String="org.study.Reader")->FrontWindow? {selectWindow(pid:42,name:"Fixture Reader",bundle:app,windows:rows)}
 let a=row(42,4,"Chapter A"), b=row(42,5,"Chapter B"), foreign=row(55,3,"Other")
 precondition(pick([a,b])?.window == 4 && pick([b,a])?.window == 5)
 precondition(pick([foreign,a]) == nil && pick([row(42,6,"Popup",3),a]) == nil)
 precondition(pick([row(42,7,"FocusDesk · 今日概览 - Google Chrome"),a]) == nil)
 precondition(pick([row(42,7,"Outlook 邮箱 · FocusDesk — Safari"),a]) == nil)
 precondition(pick([row(42,7,"document.ts — FocusDesk"),a])?.window == 7)
 precondition(pick([a],"com.agilebits.onepassword7") == nil && pick([a],"com.apple.loginwindow") == nil)
 precondition(pick([row(42,3,"1Password — Vault"),a]) == nil && pick([]) == nil)
 let win=pick([a])!; precondition(opaquePageKey(salt:"1",window:win,title:"A") != opaquePageKey(salt:"1",window:win,title:"B"))
 precondition(opaquePageKey(salt:"1",window:win,title:"A") != opaquePageKey(salt:"2",window:win,title:"A"))
 }}
`);
  const native=fileURLToPath(new URL('../src/foreground-mac/FocusDeskCapture.swift',import.meta.url));
  await run('/usr/bin/xcrun',['--sdk','macosx','swiftc','-swift-version','5','-D','FOCUSDESK_CAPTURE_FIXTURES','-parse-as-library',native,runner,'-o',exe],{timeout:110_000});
  await run(exe,[],{timeout:5000});
});
