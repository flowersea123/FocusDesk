import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { getServerInfo } from '../src/network-info.ts';
import { loadRuntimeOptions } from '../src/runtime-options.ts';

const entry = (address, internal = false, family = 'IPv4') => ({ address, internal, family, netmask: '255.255.255.0', mac: '00:11:22:33:44:55', cidr: `${address}/24` });
const networks = {
  'vEthernet (WSL)': [entry('172.20.16.1')],
  'Wi-Fi': [entry('192.168.2.10'), entry('fe80::1', false, 'IPv6')],
  Ethernet: [entry('10.1.2.3')],
  Loopback: [entry('127.0.0.1', true)],
  Broken: [entry('169.254.2.3'), entry('0.0.0.0'), entry('224.0.0.1'), entry('127.0.0.2')],
};

test('LAN info uses actual port, filters unusable addresses, ranks physical private networks first and exposes no MAC', () => {
  const info = getServerInfo('0.0.0.0', 23456, networks);
  assert.equal(info.local_url, 'http://127.0.0.1:23456/');
  assert.equal(info.connection_url, 'http://127.0.0.1:23456/connect');
  assert.deepEqual(info.addresses.map(item => item.address), ['10.1.2.3', '192.168.2.10', '172.20.16.1']);
  for (const item of info.addresses) assert.equal(item.device_api_url, `http://${item.address}:23456/api/v1/daily-overview`);
  assert.doesNotMatch(JSON.stringify(info), /00:11:22|netmask|cidr|dataPath|distPath/);
});

test('loopback/specific-IP binding never advertises unavailable local or LAN URLs', () => {
  assert.deepEqual(getServerInfo('127.0.0.1', 8787, networks).addresses, []);
  const specific = getServerInfo('192.168.2.10', 8787, networks);
  assert.equal(specific.local_url, null); assert.equal(specific.connection_url, null);
  assert.deepEqual(specific.addresses.map(item => item.address), ['192.168.2.10']);
  assert.equal(getServerInfo('127.0.0.2', 8787, networks).local_url, 'http://127.0.0.2:8787/');
});

test('address snapshots reflect an IP change, handle no network and deduplicate addresses', () => {
  const first = getServerInfo('0.0.0.0', 8787, { WiFi: [entry('192.168.1.2')] });
  const next = getServerInfo('0.0.0.0', 8787, { WiFi: [entry('192.168.1.8'), entry('192.168.1.8')] });
  assert.notEqual(first.addresses[0].device_api_url, next.addresses[0].device_api_url);
  assert.equal(next.addresses.length, 1);
  assert.deepEqual(getServerInfo('0.0.0.0', 8787, {}).addresses, []);
});

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'focusdesk-options-'));
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith('focusdesk-options-'));
    await rm(target, { recursive: true, force: true });
  });
  return root;
}

test('runtime paths follow a moved project, config is optional and default listening supports LAN', async t => {
  const root = await directory(t); const options = await loadRuntimeOptions(root, []);
  assert.equal(options.host, '0.0.0.0'); assert.equal(options.port, 8787);
  assert.equal(options.dataPath, path.join(root, 'backend', 'data', 'tasks.json'));
  assert.equal(options.distPath, path.join(root, 'frontend', 'dist'));
});

test('runtime config port is editable and CLI preserves overrides without rewriting config', async t => {
  const root = await directory(t); const file = path.join(root, 'focusdesk.config.json');
  await writeFile(file, '{"host":"0.0.0.0","port":18787}');
  assert.equal((await loadRuntimeOptions(root, [])).port, 18787);
  const explicit = await loadRuntimeOptions(root, ['--port', '19797', '--host', '127.0.0.1', '--data', './custom.json']);
  assert.equal(explicit.port, 19797); assert.equal(explicit.host, '127.0.0.1'); assert.equal(explicit.dataPath, path.resolve('custom.json'));
});

test('runtime rejects invalid config and flags instead of silently binding another port', async t => {
  const root = await directory(t); const file = path.join(root, 'focusdesk.config.json');
  for (const invalid of ['{', 'null', '[]', '{"port":"8787"}', '{"port":0}', '{"port":65536}', '{"host":"localhost"}', '{"secret":"ignored"}']) {
    await writeFile(file, invalid); await assert.rejects(loadRuntimeOptions(root, []));
  }
  await writeFile(file, '{}');
  for (const args of [['--port', '0'], ['--port', '3.5'], ['--host', 'anything'], ['--missing', 'x'], ['--port']]) await assert.rejects(loadRuntimeOptions(root, args));
});
