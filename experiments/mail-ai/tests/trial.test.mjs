import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createTrialServer } from '../trial.mjs';

const quote = 'Please submit the report by 2027-02-03 17:00 Beijing time.';
const eml = 'Subject: <b>Report</b>\r\nContent-Type: text/plain\r\n\r\n' + quote;
async function setup(t, options = {}) {
  const clock = { now: Date.parse('2027-02-01T04:00:00Z') };
  const writes = [];
  const server = createTrialServer({
    now: () => clock.now, save: async task => { writes.push(task); return {status:'added'}; },
    analyze: async mail => ({summary:mail.subject,deadlines:[{title:'Submit report',quote:mail.body,source:'body',due_local:'2027-02-03 17:00'}]}),
    ...options,
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (path, data, type='application/json', extra={}) => fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':type,...extra},body:data});
  return {origin,post,clock,writes};
}

test('trial renders a local editor, previews MIME and imports only a server-validated, still-live ticket', async t => {
  const {origin,post,writes,clock} = await setup(t);
  const page = await fetch(origin+'/');
  assert.match(await page.text(),/试用示例邮件/); assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const read = await post('/api/eml',eml,'message/rfc822');
  assert.equal(read.status,200); const result = await read.json();
  assert.equal(result.summary,'<b>Report</b>'); assert.equal(result.body,quote); assert.equal(result.candidates[0].quoteInBody,true);
  const {ticket}=result.candidates[0]; assert.ok(ticket);
  assert.equal(writes.length,0);
  assert.equal((await post('/api/import',JSON.stringify({ticket,title:'Forged title'}))).status,400);
  assert.equal((await post('/api/import',JSON.stringify({ticket:'unknown'}))).status,410);
  assert.equal((await post('/api/import',JSON.stringify({ticket}))).status,200);
  assert.equal(writes.length,1);assert.equal(writes[0].title,'Submit report');assert.equal(writes[0].dueAt,'2027-02-03T09:00:00.000Z');
  clock.now += 10*60*1000;
  assert.equal((await post('/api/import',JSON.stringify({ticket}))).status,410);
});

test('sample is valid EML relative to Beijing today; unsupported body and image claims stay unverified', async t => {
  const {post} = await setup(t,{analyze:async mail=>({summary:mail.body,deadlines:[
    {title:'Submit work',source:'image',quote:'Poster text',due_local:'2027-02-03 17:00'},
    {title:'Submit report',source:'body',quote:'Please submit the report at 17:00.',due_local:'2027-02-03 17:00'}]})});
  const response=await post('/api/sample',null,'message/rfc822');
  const data=await response.json();
  assert.equal(response.status,200);
  assert.match(data.summary,/2027-02-03 17:00/);
  assert.equal(data.candidates[0].ticket,null);assert.match(data.candidates[0].reason,/核对/);
  assert.ok(data.candidates.every(item => !item.quoteInBody && !item.ticket));
});

test('trial rejects other hosts, origins and oversized uploads before inference', async t => {
  const {post,origin} = await setup(t,{analyze:()=>assert.fail('out-of-policy request reached model')});
  assert.equal((await post('/api/eml',eml,'message/rfc822',{Origin:'http://example.invalid'})).status,403);
  const wrongHost = await new Promise((resolve,reject) => {
    const req=request(origin+'/',{headers:{Host:'example.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await post('/api/eml',eml,'text/plain')).status,415);
  const oversized = await new Promise((resolve,reject) => {
    const req=request(origin+'/api/eml',{method:'POST',headers:{Origin:origin,'Content-Type':'message/rfc822','Content-Length':8*1024*1024+1}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(oversized,413);
});
