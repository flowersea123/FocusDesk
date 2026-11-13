import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkOfficialNodeSums, NODE_RUNTIME, sha256, verifiedDownload } from '../../scripts/fetch-runtime.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'focusdesk-installer-runtime-'));
  t.after(async()=>{
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
        !path.basename(directory).startsWith('focusdesk-installer-runtime-')) throw new Error('Unsafe test cleanup');
    await rm(directory,{recursive:true,force:true});
  });
  return directory;
}

test('fixed Node release is checked against its exact official checksum entry',()=>{
  assert.equal(checkOfficialNodeSums(`${NODE_RUNTIME.sha256}  ${NODE_RUNTIME.archive}\n`),NODE_RUNTIME.sha256);
  assert.throws(()=>checkOfficialNodeSums(`${'0'.repeat(64)}  ${NODE_RUNTIME.archive}\n`),/pinned/);
  assert.throws(()=>checkOfficialNodeSums(`${NODE_RUNTIME.sha256}  another.zip\n`),/pinned/);
  assert.throws(()=>checkOfficialNodeSums(`${NODE_RUNTIME.sha256}  evil-${NODE_RUNTIME.archive}\n`),/pinned/);
});
test('download verifies bytes, uses exclusive cache and rechecks existing files',async t=>{
  const directory=await temporary(t), filename=path.join(directory,'runtime.zip');
  const bytes=Buffer.from('official artifact test fixture'); let calls=0;
  const fetchImpl=async()=>{++calls;return new Response(bytes);};
  const options={url:'https://example.invalid/fixture',filename,expectedSha256:sha256(bytes),fetchImpl};
  await verifiedDownload(options);
  assert.deepEqual(await readFile(filename),bytes);
  await verifiedDownload(options); assert.equal(calls,1);
  await writeFile(filename,'tampered');
  await assert.rejects(verifiedDownload(options),/Cached SHA-256 mismatch/);
  assert.equal(calls,1);
});
test('bad artifact checksum never publishes a cache file or leaves a partial',async t=>{
  const directory=await temporary(t), filename=path.join(directory,'bad.zip');
  await assert.rejects(verifiedDownload({url:'https://example.invalid/fixture',filename,
    expectedSha256:'0'.repeat(64),fetchImpl:async()=>new Response('corrupt')}),/SHA-256 mismatch/);
  assert.deepEqual(await readdir(directory),[]);
});
test('download HTTP failure leaves the target absent',async t=>{
  const directory=await temporary(t);
  await assert.rejects(verifiedDownload({url:'https://example.invalid/fixture',filename:path.join(directory,'missing.zip'),
    expectedSha256:'0'.repeat(64),fetchImpl:async()=>new Response('not found',{status:404})}),/HTTP 404/);
  assert.deepEqual(await readdir(directory),[]);
});
