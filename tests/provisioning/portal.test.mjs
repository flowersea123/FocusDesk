import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../firmware/experiments/focusdesk_provisioning_poc/portal_page.h', import.meta.url), 'utf8');
const script = source.match(/<script>([\s\S]+?)<\/script>/)[1];
const TOKEN = 'a'.repeat(32);
const HUB = 'http://192.168.1.10:8787';
const status = extra => ({state:'idle',attempt_id:'',wifi_connected:false,ip:'0.0.0.0',channel:1,
  disconnect_reason:0,ap_joins:1,ap_leaves:0,remaining_s:570,subnet_conflict:false,
  config:{saved:false,storage_ready:true,hub_url:''},result:'none',error:'',
  heap:{free:180000,min_free:170000,largest:120000,psram:0,loop_stack:5000,http_stack:3000},
  hardware:{chip:'ESP32-S3',revision:2,cores:2,flash_bytes:8388608,psram_bytes:0,core:'3.3.12',idf:'5.5.5'},...extra});
const reply = (data, code = 200) => ({ok:code >= 200 && code < 300,status:code,json:async () => data});
async function flush() { for (let i=0;i<20;i++) await Promise.resolve(); }
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
async function page({responses=[], saved, brokenStorage=false}={}) {
  const elements = new Map(), timers = new Map(), calls = [], storage = new Map();
  if (saved) storage.set('focusdesk-poc-attempt',saved);
  const node = id => {
    if (!elements.has(id)) elements.set(id,{value:'',textContent:'',hidden:false,disabled:false,listeners:{},
      addEventListener(type,handler) {this.listeners[type]=handler;}});
    return elements.get(id);
  };
  let sequence=0,active=0,peak=0,now=1700000000000;
  class ClockDate extends Date {static now(){return now;}}
  const context = vm.createContext({
    document:{getElementById:node},URLSearchParams,TextEncoder,AbortController,Date:ClockDate,
    sessionStorage:{getItem:key=>{if(brokenStorage)throw Error('Disabled');return storage.get(key)??null;},
      setItem:(key,value)=>{if(brokenStorage)throw Error('Disabled');storage.set(key,value);},
      removeItem:key=>{if(brokenStorage)throw Error('Disabled');storage.delete(key);}},
    setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,delay});return id;},
    clearTimeout(id){timers.delete(id);},
    fetch:async (url,options) => {
      calls.push({url,...options});active++;peak=Math.max(peak,active);
      try {
        assert(responses.length,'Unexpected request: '+url);
        const next=responses.shift();
        if(next instanceof Error)throw next;
        return typeof next==='function'?await next({url,...options}):await next;
      } finally {active--;}
    },
    console:{log(){throw Error('Page must not log credentials');},error(){throw Error('Page must not log credentials');}}
  });
  vm.runInContext(script,context);
  await flush();
  return {node,calls,responses,timers,storage,get peak(){return peak;},
    advance(milliseconds){now+=milliseconds;},
    async poll(delay=2000){const entry=[...timers].find(([,t])=>t.delay===delay);assert(entry,'Missing poll timer');timers.delete(entry[0]);entry[1].fn();await flush();},
    input(id,value){node(id).value=value;node(id).listeners.input?.();},
    async submit(ssid,password,hubUrl=HUB){node('ssid').value=ssid;node('password').value=password;node('hub-url').value=hubUrl;await node('wifi-form').listeners.submit({preventDefault(){}});await flush();},
  };
}
const initial = () => [reply({token:TOKEN,remaining_s:600}),reply(status())];

test('page reads actual runtime hardware/memory and has no external resource dependency',async()=>{
  const ui=await page({responses:initial()});
  assert.equal(ui.node('heap-min').textContent,'170000');
  assert.match(ui.node('chip').textContent,/ESP32-S3/);
  assert.equal(ui.node('connect').disabled,false);
  assert.equal(ui.peak,1);
  assert(!/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i.test(source));
});

test('Chinese SSID, spaces, plus, ampersand and quote round-trip in the actual POST without trimming',async()=>{
  let posted;
  const ui=await page({responses:[...initial(),request=>{
    posted=request;
    return reply({attempt_id:new URLSearchParams(request.body).get('attempt_id')},202);
  }]});
  const ssid=' 工作桌 + & " ', password=' pass+&"\\word ';
  await ui.submit(ssid,password);
  assert.equal(posted.method,'POST');
  assert.equal(posted.headers['X-FocusDesk-Token'],TOKEN);
  const body=new URLSearchParams(posted.body);
  assert.equal(body.get('ssid'),ssid);assert.equal(body.get('password'),password);
  assert.equal(body.get('hub_url'),HUB);
  assert.match(body.get('attempt_id'),/^[a-zA-Z0-9-]{1,48}$/);
  assert.equal(ui.node('password').value,'');
  assert(![...ui.storage.values()].some(value=>value.includes(password)));
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
});

test('SSID UTF-8 byte limit, control characters, open Wi-Fi and 64-character raw PSK are rejected before sending',async()=>{
  const ui=await page({responses:initial()});
  for(const [ssid,password] of [['中'.repeat(11),'password'],['a\0b','password'],['abc',''],['abc','a'.repeat(64)],['abc','中文密码password']]){
    await ui.submit(ssid,password);
    assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
  }
});

test('lost POST response is uncertain, stored before sending, and never automatically reposted',async()=>{
  let attempt;
  const ui=await page({responses:[...initial(),request=>{
    attempt=new URLSearchParams(request.body).get('attempt_id');
    assert.equal(ui.storage.get('focusdesk-poc-attempt'),attempt);
    throw Error('Phone lost AP during channel switch');
  }]});
  await ui.submit('desk','password');
  assert.match(ui.node('result').textContent,/unknown/i);
  ui.responses.push(reply(status({state:'connecting',attempt_id:attempt,result:'testing'})));
  await ui.poll(0);
  assert.match(ui.node('result').textContent,/trying to connect/i);
  ui.responses.push(reply(status({state:'connected',wifi_connected:true,ip:'192.168.1.30',attempt_id:attempt,channel:11,
    result:'saved',config:{saved:true,storage_ready:true,hub_url:HUB}})));
  await ui.poll();
  assert.match(ui.node('result').textContent,/Wi-Fi is connected/);
  assert.equal(ui.node('ip').textContent,'192.168.1.30');
  assert.equal(ui.node('channel').textContent,'11');
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(ui.storage.size,0);
});

test('reload queries a pending attempt and different device operation never confirms the submitted request',async()=>{
  const ui=await page({saved:'previous-123',responses:[reply({token:TOKEN,remaining_s:500}),reply(status({
    state:'connected',wifi_connected:true,attempt_id:'other-456',ip:'192.168.1.8'}))]});
  assert.match(ui.node('result').textContent,/not confirmed/);
  assert.match(ui.node('operation').textContent,/previous-123/);
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
});

test('failed query retries GET and does not overlap another query or silently repeat a submission',async()=>{
  const held=deferred();
  const ui=await page({responses:[...initial(),()=>held.promise]});
  await ui.poll();
  assert.equal(ui.calls.length,3);
  assert.equal([...ui.timers.values()].filter(t=>t.delay===2000).length,0);
  held.reject(Error('Offline'));await flush();
  assert.match(ui.node('link').textContent,/No current device response/);
  ui.responses.push(reply(status({state:'disconnected'})));
  await ui.poll();
  assert.match(ui.node('result').textContent,/lost its Wi-Fi/);
  assert.equal(ui.peak,1);
});

test('session replacement reacquires token using GET and never resends credentials',async()=>{
  const ui=await page({responses:[...initial(),reply({},403)]});
  await ui.poll();
  assert.equal(ui.node('connect').disabled,true);
  ui.responses.push(reply({token:'b'.repeat(32),remaining_s:590}),reply(status()));
  await ui.poll();
  assert.equal(ui.calls.at(-1).headers['X-FocusDesk-Token'],'b'.repeat(32));
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
});

test('expired window disables form and stops polling with an explicit physical restart instruction',async()=>{
  const ui=await page({responses:[reply({},410)]});
  assert.match(ui.node('result').textContent,/Press RST/);
  assert.equal(ui.node('connect').disabled,true);
  assert.equal(ui.timers.size,0);
  await ui.submit('desk','password');
  assert.equal(ui.calls.length,1);
});

test('HTTP busy/rejected response is not reported as successful or silently retried',async()=>{
  const ui=await page({responses:[...initial(),reply({},409)]});
  await ui.submit('desk','password');
  assert.match(ui.node('result').textContent,/already testing/);
  assert.equal(ui.storage.size,0);
  ui.responses.push(reply(status({state:'connecting',attempt_id:'device-999',result:'testing'})));
  await ui.poll(0);
  assert.equal(ui.node('connect').disabled,true);
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
});

test('malformed status is not success and unsafe device text is only assigned as textContent',async()=>{
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),reply({state:'connected',wifi_connected:'true',remaining_s:500,attempt_id:''})]});
  assert.match(ui.node('link').textContent,/No current device response/);
  ui.responses.push(reply(status({hardware:{chip:'<img onerror=alert(1)>',revision:0,cores:2},subnet_conflict:true})));
  await ui.poll();
  assert.match(ui.node('chip').textContent,/<img/);
  assert.equal(ui.node('warning').hidden,false);
  assert(!script.includes('innerHTML'));
});

test('disabled browser storage still permits a single test and live result queries',async()=>{
  const ui=await page({brokenStorage:true,responses:[...initial(),request=>reply({attempt_id:new URLSearchParams(request.body).get('attempt_id')},202)]});
  await ui.submit('desk','password');
  assert.match(ui.node('result').textContent,/Request accepted/);
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
});

test('submitting while status is in flight waits for it and serializes network requests',async()=>{
  const held=deferred();
  const ui=await page({responses:[...initial(),()=>held.promise,request=>reply({attempt_id:new URLSearchParams(request.body).get('attempt_id')},202)]});
  await ui.poll();
  const submit=ui.submit('desk','password');
  await flush();assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
  held.resolve(reply(status()));await submit;
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(ui.peak,1);
});

test('a timed-out POST keeps its attempt pending and recovery only queries the device',async()=>{
  const ui=await page({responses:[...initial(),request=>new Promise((resolve,reject)=>{
    request.signal.addEventListener('abort',()=>reject(Error('Timed out')),{once:true});
  })]});
  const submit=ui.submit('desk','password');await flush();
  const timeout=[...ui.timers].find(([,timer])=>timer.delay===8000);
  assert(timeout);ui.timers.delete(timeout[0]);timeout[1].fn();await submit;
  assert.match(ui.node('result').textContent,/unknown/);
  assert(ui.storage.get('focusdesk-poc-attempt'));
  ui.responses.push(reply(status({state:'idle'})));await ui.poll(0);
  assert.match(ui.node('result').textContent,/not confirmed/);
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
});

test('if the in-flight query reveals a busy device, a waiting form submit does not send another POST',async()=>{
  const held=deferred();
  const ui=await page({responses:[...initial(),()=>held.promise]});
  await ui.poll();
  const submit=ui.submit('desk','password');await flush();
  held.resolve(reply(status({state:'connecting',attempt_id:'another-operation',result:'testing'})));await submit;
  assert.match(ui.node('result').textContent,/already testing/);
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
});

for (const state of ['queued','connecting','verifying','saving']) {
  test(`${state} with a leftover connected flag cannot confirm the new attempt`,async()=>{
    const ui=await page({saved:'new-attempt',responses:[reply({token:TOKEN,remaining_s:600}),reply(status({
      state,wifi_connected:true,attempt_id:'new-attempt',ip:'192.168.1.5',result:'testing'}))]});
    if (state !== 'verifying') assert(!ui.node('result').textContent.includes('Wi-Fi is connected'));
    assert(!ui.node('result').textContent.includes('were saved'));
    assert.equal(ui.storage.get('focusdesk-poc-attempt'),'new-attempt');
    assert.equal(ui.node('connect').disabled,true);
    await ui.submit('replacement','password');
    assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
  });
}

for (const result of ['none','failed']) {
  test(`a background reconnect with result ${result} permits replacement settings immediately`,async()=>{
    const config={saved:true,storage_ready:true,hub_url:HUB};
    const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),reply(status({
      state:'connecting',result,config,error:result==='failed'?'WIFI_FAILED':''
    })),request=>reply({attempt_id:new URLSearchParams(request.body).get('attempt_id')},202)]});
    assert.equal(ui.node('connect').disabled,false);
    await ui.submit('replacement','password');
    assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
    assert.match(ui.node('result').textContent,/Request accepted/);
  });
}

test('a background restore discovered during a status query does not prevent a waiting replacement submission',async()=>{
  const held=deferred();
  const ui=await page({responses:[...initial(),()=>held.promise,
    request=>reply({attempt_id:new URLSearchParams(request.body).get('attempt_id')},202)]});
  await ui.poll();
  const submit=ui.submit('replacement','password');
  await flush();
  held.resolve(reply(status({state:'connecting',result:'none',config:{saved:true,storage_ready:true,hub_url:HUB}})));
  await submit;
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(ui.peak,1);
});

test('when AP closes without an expiry response, the remembered deadline ends the UI after a failed query',async()=>{
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:3}),reply(status({remaining_s:3}))]});
  ui.advance(1000);await ui.poll(1000);
  assert.equal(ui.node('remaining').textContent,'2 seconds');
  ui.advance(2500);ui.responses.push(Error('AP has closed'));await ui.poll();
  assert.match(ui.node('result').textContent,/Press RST/);
  assert.equal(ui.node('connect').disabled,true);
  assert.equal(ui.node('remaining').textContent,'0 seconds');
  assert.equal(ui.timers.size,0);
});

test('Hub address is required and rejects credentials, arbitrary paths, invalid hosts and ports before sending',async()=>{
  const ui=await page({responses:initial()});
  const invalid = [
    '', 'https://192.168.1.10:8787', 'http://localhost:8787', 'http://192.168.1.999:8787',
    'http://0.0.0.0:8787', 'http://127.0.0.1:8787', 'http://224.1.2.3:8787',
    'http://169.254.1.2:8787', 'http://192.168.4.1:8787', 'http://192.168.004.1:8787',
    'http://192.168.1.10:0', 'http://192.168.1.10:65536', 'http://192.168.1.10:8787/connect',
    'http://user:password@192.168.1.10:8787', 'http://192.168.1.10:8787/?x=y',
    'http://192.168.1.10:8787/#section', 'http://192.168.1.10:8787\\evil',
    ' http://192.168.1.10:8787', 'http://192.168.1.10:8787\n', 'http://'+'a'.repeat(96),
  ];
  for (const hub of invalid) {
    await ui.submit('desk','password',hub);
    assert.equal(ui.calls.filter(call=>call.method==='POST').length,0,hub);
  }
});

test('Hub root and existing daily-overview URLs are accepted and sent once without rewriting user input',async()=>{
  for (const hub of [HUB,HUB+'/',HUB+'/api/v1/daily-overview','http://10.0.0.2','http://172.16.1.2:65535']) {
    let posted;
    const ui=await page({responses:[...initial(),request=>{
      posted=request;
      return reply({attempt_id:new URLSearchParams(request.body).get('attempt_id')},202);
    }]});
    await ui.submit('desk','password',hub);
    assert.equal(new URLSearchParams(posted.body).get('hub_url'),hub);
    assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
  }
});

test('saved Hub is prefilled while SSID and password stay empty and user edits survive polling',async()=>{
  const config={saved:true,storage_ready:true,hub_url:HUB};
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),reply(status({config}))]});
  assert.equal(ui.node('hub-url').value,HUB);
  assert.equal(ui.node('ssid').value,'');
  assert.equal(ui.node('password').value,'');
  assert.equal(ui.node('saved-hub').textContent,HUB);
  ui.input('hub-url','');
  ui.responses.push(reply(status({config})));
  await ui.poll();
  assert.equal(ui.node('hub-url').value,'');
  ui.input('hub-url','http://10.0.0.2:8787');
  ui.responses.push(reply(status({config})));
  await ui.poll();
  assert.equal(ui.node('hub-url').value,'http://10.0.0.2:8787');
});

test('typing before the first status arrives keeps the new Hub instead of replacing it with the saved value',async()=>{
  const held=deferred();
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),()=>held.promise]});
  ui.input('hub-url','http://10.0.0.2:8787');
  held.resolve(reply(status({config:{saved:true,storage_ready:true,hub_url:HUB}})));
  await flush();
  assert.equal(ui.node('hub-url').value,'http://10.0.0.2:8787');
});

test('boot-restored connection is shown separately from the result of a newly saved configuration',async()=>{
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),reply(status({
    state:'connected',wifi_connected:true,ip:'192.168.1.30',config:{saved:true,storage_ready:true,hub_url:HUB}
  }))]});
  assert.match(ui.node('result').textContent,/using its saved configuration/);
  assert(!ui.node('result').textContent.includes('were saved'));
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);
});

test('failed candidate stays failed while the previous saved Wi-Fi reconnects',async()=>{
  for (const error of ['WIFI_FAILED','HUB_UNREACHABLE','HUB_INVALID','NVS_SAVE_FAILED','SUBNET_CONFLICT']) {
    const config={saved:true,storage_ready:true,hub_url:HUB};
    const ui=await page({saved:'failed-attempt',responses:[reply({token:TOKEN,remaining_s:600}),reply(status({
      state:'connected',wifi_connected:true,attempt_id:'failed-attempt',result:'failed',error,config,ip:'192.168.1.30'
    }))]});
    const expected = error === 'NVS_SAVE_FAILED' ? /reloaded its saved record/ : /previous saved configuration has been kept/;
    assert.match(ui.node('result').textContent,expected);
    assert(!ui.node('result').textContent.includes('were saved'));
    assert.equal(ui.storage.size,0);
    ui.responses.push(reply(status({state:'connected',wifi_connected:true,attempt_id:'failed-attempt',result:'failed',error,config})));
    await ui.poll();
    assert.match(ui.node('result').textContent,expected);
  }
});

test('failed first configuration explains that nothing was saved',async()=>{
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),reply(status({
    state:'failed',result:'failed',error:'HUB_UNREACHABLE'
  }))]});
  assert.match(ui.node('result').textContent,/No configuration was saved/);
  assert.equal(ui.node('saved').textContent,'No saved settings');
});

test('Wi-Fi association without a committed configuration never reports saved success',async()=>{
  for (const result of ['none','testing','saved']) {
    const ui=await page({saved:'new-attempt',responses:[reply({token:TOKEN,remaining_s:600}),reply(status({
      state:'connected',wifi_connected:true,attempt_id:'new-attempt',result
    }))]});
    assert(!ui.node('result').textContent.includes('were saved'));
    assert.equal(ui.storage.get('focusdesk-poc-attempt'),'new-attempt');
  }
});

test('storage failure disables submissions and a storage change during a query also blocks the POST',async()=>{
  const config={saved:true,storage_ready:false,hub_url:HUB};
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:600}),reply(status({config}))]});
  assert.equal(ui.node('connect').disabled,true);
  assert.match(ui.node('result').textContent,/storage is unavailable/);
  await ui.submit('desk','password');
  assert.equal(ui.calls.filter(call=>call.method==='POST').length,0);

  const held=deferred();
  const changed=await page({responses:[...initial(),()=>held.promise]});
  await changed.poll();
  const submit=changed.submit('desk','password');
  await flush();
  held.resolve(reply(status({config})));
  await submit;
  assert.equal(changed.calls.filter(call=>call.method==='POST').length,0);
  assert.equal(changed.node('connect').disabled,true);
});

test('countdown can end a silent setup window without receiving another HTTP response',async()=>{
  const ui=await page({responses:[reply({token:TOKEN,remaining_s:2}),reply(status({remaining_s:2}))]});
  ui.advance(2100);await ui.poll(1000);
  assert.match(ui.node('result').textContent,/Press RST/);
  assert.equal(ui.node('connect').disabled,true);
  assert.equal(ui.timers.size,0);
});
