import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = await readFile(new URL('../../backend/public/connect.html', import.meta.url), 'utf8');
const snapshot = (address = '192.168.1.20') => ({ local_url: 'http://127.0.0.1:18787/', addresses: [{
  interface: 'Wi-Fi', address, dashboard_url: `http://${address}:18787/`, device_api_url: `http://${address}:18787/api/v1/daily-overview`,
}] });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function page(t, fetcher) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:18787/connect', runScripts: 'dangerously', beforeParse(window) {
    window.fetch = fetcher; window.AbortSignal = AbortSignal;
  } });
  t.after(() => dom.window.close()); return dom.window;
}

test('connection page renders current URLs, updates changed IPs, and treats interface names as text', async t => {
  let info = snapshot(); info.addresses[0].interface = '<img src=x onerror="window.injected=true">';
  const window = page(t, async () => ({ ok: true, json: async () => info })); await settle();
  const document = window.document;
  assert.equal(document.getElementById('local').textContent, info.local_url);
  assert.equal(document.querySelector('input').value, info.addresses[0].device_api_url);
  assert.equal(document.querySelectorAll('img').length, 0); assert.equal(window.injected, undefined);
  info = snapshot('192.168.1.33'); document.getElementById('refresh').click(); await settle();
  assert.equal(document.querySelector('input').value, info.addresses[0].device_api_url);
  assert.doesNotMatch(document.getElementById('addresses').textContent, /192\.168\.1\.20/);
});

test('connection page has copy fallback, reports stale/error state and handles no available LAN address', async t => {
  let failure = false, info = snapshot();
  const window = page(t, async () => { if (failure) throw Error('offline'); return { ok: true, json: async () => info }; });
  await settle(); const document = window.document;
  document.querySelector('.row button').click(); await settle();
  assert.match(document.getElementById('status').textContent, /Ctrl\+C/);
  failure = true; document.getElementById('refresh').click(); await settle();
  assert.equal(document.getElementById('error').hidden, false); assert.match(document.getElementById('error').textContent, /可能过期/);
  assert.equal(document.querySelector('input').value, info.addresses[0].device_api_url);
  failure = false; info = { local_url: null, addresses: [] }; document.getElementById('refresh').click(); await settle();
  assert.equal(document.getElementById('error').hidden, true); assert.equal(document.querySelectorAll('input').length, 0);
  assert.match(document.getElementById('status').textContent, /暂未发现/);
  assert.match(document.getElementById('local').textContent, /0\.0\.0\.0/);
});
