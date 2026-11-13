// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <Arduino.h>

constexpr char POC_PORTAL_PAGE[] PROGMEM = R"FDHTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'">
<title>FocusDesk device settings</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5ef;color:#25382a;font:16px/1.55 system-ui,sans-serif}main{max-width:660px;margin:auto;padding:24px 18px 48px}h1{font-size:26px;line-height:1.2}h2{font-size:19px}section{background:#fff;border:1px solid #d5ddcf;border-radius:12px;padding:20px;margin:18px 0}label{display:block;margin:14px 0 5px}input,button{font:inherit;width:100%;padding:11px;border:1px solid #98a78e;border-radius:6px}button{margin-top:18px;background:#355b3c;color:#fff;cursor:pointer}button:disabled{opacity:.55;cursor:wait}p{margin:8px 0}.small{font-size:14px;color:#52614e}.notice{border-left:4px solid #b18d25;padding-left:12px}#result{font-weight:600;overflow-wrap:anywhere}dl{margin:12px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;font-size:14px}dt{color:#52614e}dd{margin:0;text-align:right;overflow-wrap:anywhere}code{overflow-wrap:anywhere}input:focus-visible,button:focus-visible{outline:3px solid #c3a349;outline-offset:2px}
</style>
</head>
<body><main>
<p class="small">FOCUSDESK / DEVICE SETTINGS EXPERIMENT</p>
<h1>Connect your device to Wi-Fi and Hub</h1>
<p>Keep this phone connected to the FocusDesk setup hotspot, even when your phone says it has no internet.</p>
<p class="notice small">Use a 2.4 GHz personal Wi-Fi network. Joining it may change the setup hotspot's channel and temporarily disconnect your phone. Rejoin the same hotspot and reopen <code>http://192.168.4.1</code> to check the result.</p>
<section>
<form id="wifi-form" autocomplete="off">
<label for="ssid">Wi-Fi name (SSID)</label>
<input id="ssid" name="ssid" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required aria-describedby="ssid-help">
<p id="ssid-help" class="small">1-32 UTF-8 bytes. Chinese names and spaces are supported. Names and passwords are used exactly as entered.</p>
<label for="password">Wi-Fi password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="63" required aria-describedby="password-help">
<p id="password-help" class="small">8-63 printable ASCII characters. This experiment does not support open Wi-Fi, enterprise login, or a 64-character raw PSK.</p>
<label for="hub-url">FocusDesk Hub address</label>
<input id="hub-url" name="hub_url" type="text" maxlength="95" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="http://192.168.1.10:8787" aria-describedby="hub-help">
<p id="hub-help" class="small">Start FocusDesk on your computer and copy its LAN address from the device connection page. You can also paste its full daily-overview API address.</p>
<button id="connect" type="submit" disabled>Save and connect</button>
</form>
</section>
<section aria-live="polite" aria-atomic="false">
<h2>Device result</h2>
<p id="result">Reading device status...</p>
<p id="operation" class="small"></p>
<p id="link" class="small">No connection result yet.</p>
<p id="warning" class="notice small" hidden></p>
<dl>
<dt>Device IP on your Wi-Fi</dt><dd id="ip">-</dd>
<dt>Current radio channel</dt><dd id="channel">-</dd>
<dt>Phone joins / leaves</dt><dd id="clients">-</dd>
<dt>Last disconnect reason</dt><dd id="reason">-</dd>
<dt>Setup time remaining</dt><dd id="remaining">-</dd>
<dt>Saved configuration</dt><dd id="saved">-</dd>
<dt>Saved Hub address</dt><dd id="saved-hub">-</dd>
</dl>
</section>
<section>
<h2>Memory and hardware</h2>
<p class="small">All memory values below are bytes reported by this running device.</p>
<dl>
<dt>Internal heap free</dt><dd id="heap-free">-</dd>
<dt>Internal heap minimum</dt><dd id="heap-min">-</dd>
<dt>Largest internal block</dt><dd id="heap-largest">-</dd>
<dt>PSRAM free</dt><dd id="heap-psram">-</dd>
<dt>Loop / HTTP stack minimum</dt><dd id="stack">-</dd>
<dt>Chip / revision / cores</dt><dd id="chip">-</dd>
<dt>Detected flash</dt><dd id="flash">-</dd>
<dt>Initialized PSRAM</dt><dd id="psram">-</dd>
<dt>Arduino Core / ESP-IDF</dt><dd id="versions">-</dd>
</dl>
</section>
<p class="small">The device tests the new Wi-Fi and Hub before saving them in persistent storage. Saved settings restore automatically after a restart. The setup hotspot closes after 10 minutes while the saved Wi-Fi connection continues. Press RST to reopen settings and change your Wi-Fi or Hub address.</p>
</main>
<script>
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const form = byId('wifi-form'), button = byId('connect');
  const storageKey = 'focusdesk-poc-attempt';
  const states = new Set(['idle','queued','connecting','verifying','saving','connected','failed','disconnected','expired']);
  const results = new Set(['none','testing','saved','failed']);
  const busyStates = new Set(['queued','connecting','verifying','saving']);
  const isBusy = status => status.result === 'testing' && busyStates.has(status.state);
  let token = '', lastStatus = null, pendingAttempt = '', counter = 0;
  let pollTimer = null, pollTask = null, submitting = false, expired = false;
  let windowDeadline = null, countdownTimer = null;
  let hubEdited = false;
  byId('hub-url').addEventListener('input', () => { hubEdited = true; });
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved && /^[A-Za-z0-9-]{1,48}$/.test(saved)) pendingAttempt = saved;
  } catch {}

  function rememberAttempt(value) {
    pendingAttempt = value;
    try {
      if (value) sessionStorage.setItem(storageKey, value);
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }
  function say(message) { byId('result').textContent = message; }
  function number(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '-';
  }
  function updateButton() {
    button.disabled = submitting || expired || !token ||
      !!(lastStatus && (!lastStatus.config.storage_ready || isBusy(lastStatus)));
    button.textContent = submitting ? 'Sending request...' : 'Save and connect';
  }
  function validHub(value) {
    if (new TextEncoder().encode(value).length > 95) return false;
    const parts = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?(?:\/|\/api\/v1\/daily-overview)?$/.exec(value);
    if (!parts) return false;
    const octets = parts.slice(1, 5).map(Number);
    if (parts.slice(1, 5).some(part => part.length > 1 && part[0] === '0') || octets.some(part => part > 255)) return false;
    const [a,b,c] = octets;
    if (!a || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168 && c === 4)) return false;
    return !parts[5] || (Number(parts[5]) > 0 && Number(parts[5]) <= 65535);
  }
  function endSession() {
    expired = true;
    token = '';
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (countdownTimer !== null) clearTimeout(countdownTimer);
    pollTimer = null;
    countdownTimer = null;
    byId('remaining').textContent = '0 seconds';
    say('The setup window has ended. Press RST, rejoin the hotspot, and reopen this page.');
    updateButton();
  }
  function updateDeadline(seconds) {
    windowDeadline = Date.now() + Math.max(0, seconds) * 1000;
    if (countdownTimer !== null) clearTimeout(countdownTimer);
    const tick = () => {
      countdownTimer = null;
      if (expired) return;
      const remaining = Math.max(0, Math.ceil((windowDeadline - Date.now()) / 1000));
      byId('remaining').textContent = String(remaining) + ' seconds';
      if (!remaining) { endSession(); return; }
      countdownTimer = setTimeout(tick, 1000);
    };
    tick();
  }
  function render(status) {
    if (expired) return;
    if (!status || !states.has(status.state) || !results.has(status.result) || typeof status.wifi_connected !== 'boolean' ||
        typeof status.attempt_id !== 'string' || !Number.isFinite(status.remaining_s) ||
        !status.config || typeof status.config.saved !== 'boolean' || typeof status.config.storage_ready !== 'boolean' ||
        typeof status.config.hub_url !== 'string' || typeof status.error !== 'string') {
      throw new Error('INVALID_STATUS');
    }
    lastStatus = status;
    if (status.state === 'expired' || status.remaining_s <= 0) { endSession(); return; }
    updateDeadline(status.remaining_s);
    if (status.config.saved && !hubEdited && !byId('hub-url').value && validHub(status.config.hub_url)) {
      byId('hub-url').value = status.config.hub_url;
    }
    const mismatch = !!pendingAttempt && pendingAttempt !== status.attempt_id;
    if (mismatch) {
      say('Your submitted attempt is not confirmed. The device is reporting a different operation. Do not assume the request was saved.');
    } else if (!status.config.storage_ready) {
      say('Device storage is unavailable. Saving is disabled. Restart the device and check its storage before trying again.');
    } else if (status.result === 'failed') {
      const errors = {
        WIFI_FAILED:'The new Wi-Fi connection failed.',
        HUB_UNREACHABLE:'The FocusDesk Hub could not be reached. Check the computer address, FocusDesk app, and network access.',
        HUB_INVALID:'The address did not return a valid FocusDesk Hub response.',
        NVS_SAVE_FAILED:'The new settings could not be saved to device storage.',
        STORAGE_UNAVAILABLE:'Device storage is unavailable.',
        SUBNET_CONFLICT:'The router and setup hotspot use overlapping network addresses.'
      };
      let previous = ' No configuration was saved. Check the settings and try again.';
      if (status.config.saved) {
        previous = status.error === 'NVS_SAVE_FAILED' ?
          ' The device reloaded its saved record and will reconnect to it. Check the saved Hub below before retrying.' :
          ' The previous saved configuration has been kept. The device will reconnect to it automatically.';
      }
      say((errors[status.error] || 'The new configuration failed validation.') + previous);
      if (pendingAttempt && pendingAttempt === status.attempt_id) rememberAttempt('');
    } else if (status.state === 'connected' && status.wifi_connected && status.result === 'saved' && status.config.saved) {
      say('Wi-Fi is connected. Your Wi-Fi and Hub settings were saved and will restore after a restart.');
      if (pendingAttempt && pendingAttempt === status.attempt_id) rememberAttempt('');
    } else if (status.state === 'connected' && status.wifi_connected && status.result === 'none' && status.config.saved) {
      say('The device is connected using its saved configuration.');
    } else {
      const labels = {
        idle:'Ready to save your Wi-Fi and Hub settings.',
        queued:'Request accepted. Waiting to test the new settings.',
        connecting:status.result === 'none' && status.config.saved ?
          'The device is reconnecting using its saved settings. You can submit replacement settings now.' :
          'The device is trying to connect. Rejoin the setup hotspot if your phone disconnects.',
        verifying:'Wi-Fi is connected. Checking the FocusDesk Hub before saving.',
        saving:'Wi-Fi and Hub checks passed. Saving settings to the device.',
        connected:'The configuration is not confirmed as saved. Check the current device result again.',
        failed:'The connection test failed. Check the settings and current device result.',
        disconnected:'The device lost its Wi-Fi connection. It will retry its saved configuration automatically.'
      };
      say(labels[status.state]);
    }
    byId('operation').textContent = 'Device operation: ' + (status.attempt_id || 'none') +
      (mismatch ? ' | This page submitted: ' + pendingAttempt : '');
    byId('link').textContent = 'Device Wi-Fi: ' + (status.wifi_connected ? 'connected' : 'not connected') +
      '. Wi-Fi connectivity and saved configuration are reported separately by the device.';
    byId('ip').textContent = status.wifi_connected && typeof status.ip === 'string' ? status.ip : '-';
    byId('channel').textContent = number(status.channel);
    byId('clients').textContent = number(status.ap_joins) + ' / ' + number(status.ap_leaves);
    byId('reason').textContent = number(status.disconnect_reason);
    byId('saved').textContent = status.config.saved ? 'Available after restart' : 'No saved settings';
    byId('saved-hub').textContent = status.config.saved ? status.config.hub_url : '-';
    byId('warning').hidden = !status.subnet_conflict;
    byId('warning').textContent = status.subnet_conflict ?
      'Your router and the setup hotspot use overlapping addresses. This experiment may lose access to the setup page. Test with another network.' : '';
    const heap = status.heap || {}, hardware = status.hardware || {};
    byId('heap-free').textContent = number(heap.free);
    byId('heap-min').textContent = number(heap.min_free);
    byId('heap-largest').textContent = number(heap.largest);
    byId('heap-psram').textContent = number(heap.psram);
    byId('stack').textContent = number(heap.loop_stack) + ' / ' + number(heap.http_stack);
    byId('chip').textContent = (typeof hardware.chip === 'string' ? hardware.chip : '-') +
      ' / ' + number(hardware.revision) + ' / ' + number(hardware.cores);
    byId('flash').textContent = number(hardware.flash_bytes);
    byId('psram').textContent = number(hardware.psram_bytes) + ' (0 can mean PSRAM is disabled)';
    byId('versions').textContent = (typeof hardware.core === 'string' ? hardware.core : '-') +
      ' / ' + (typeof hardware.idf === 'string' ? hardware.idf : '-');
    updateButton();
  }
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache:'no-store', credentials:'omit' });
      if (!response.ok) {
        const error = new Error('HTTP_ERROR');
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function schedule(delay = 2000) {
    if (expired || submitting) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; refresh(); }, delay);
  }
  function refresh() {
    if (expired || submitting || pollTask) return pollTask;
    pollTask = (async () => {
      try {
        if (!token) {
          let session;
          try { session = await request('/api/session'); }
          catch (error) {
            if (error.status === 403 || error.status === 410) { endSession(); return; }
            throw error;
          }
          if (!session || typeof session.token !== 'string' || !/^[a-f0-9]{32}$/.test(session.token) ||
              !Number.isFinite(session.remaining_s)) throw new Error('INVALID_SESSION');
          if (session.remaining_s <= 0) { endSession(); return; }
          if (expired) return;
          updateDeadline(session.remaining_s);
          token = session.token;
        }
        const status = await request('/api/status', {headers:{'X-FocusDesk-Token':token}});
        render(status);
      } catch (error) {
        if (expired || (windowDeadline !== null && Date.now() >= windowDeadline)) { endSession(); return; }
        if (error.status === 403) token = '';
        say(pendingAttempt ?
          'Connection result is unknown. Rejoin the same setup hotspot; this page will query again. Your request will not be sent again automatically.' :
          'Cannot read the device. Rejoin the setup hotspot and keep this page open; status queries will retry.');
        byId('link').textContent = 'No current device response. Previous results may be out of date.';
      } finally {
        pollTask = null;
        updateButton();
        schedule();
      }
    })();
    return pollTask;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || expired || !token || !lastStatus || !lastStatus.config.storage_ready || isBusy(lastStatus)) return;
    const ssid = byId('ssid').value, password = byId('password').value;
    const hubUrl = byId('hub-url').value;
    const bytes = new TextEncoder().encode(ssid).length;
    if (bytes < 1 || bytes > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) {
      say('Enter a Wi-Fi name of 1-32 UTF-8 bytes without control characters.'); return;
    }
    if (!/^[\x20-\x7e]{8,63}$/.test(password)) {
      say('Enter 8-63 printable ASCII password characters. Open Wi-Fi and 64-character raw PSKs are not supported.'); return;
    }
    if (!validHub(hubUrl)) {
      say('Enter the Hub LAN address as http://IPv4:port, optionally followed by /api/v1/daily-overview.'); return;
    }
    submitting = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    byId('password').value = '';
    updateButton();
    try {
      if (pollTask) await pollTask;
      if (!token || expired) { say('The device session changed. Check its status before submitting again.'); return; }
      if (!lastStatus || !lastStatus.config.storage_ready) {
        say('Device storage is unavailable. The new settings were not submitted.'); return;
      }
      if (isBusy(lastStatus)) {
        say('The device is already testing a connection. Wait for its current result before starting another test.'); return;
      }
      const attempt = Date.now().toString(16) + '-' + (++counter).toString(16);
      rememberAttempt(attempt);
      const body = new URLSearchParams({ssid,password,hub_url:hubUrl,attempt_id:attempt}).toString();
      say('Sending new settings for Wi-Fi and Hub checks before saving. Rejoin the hotspot if the phone disconnects.');
      const result = await request('/api/connect', {
        method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','X-FocusDesk-Token':token}, body
      });
      if (!result || result.attempt_id !== attempt) throw new Error('UNCONFIRMED_OPERATION');
      if (!expired) say('Request accepted. Querying the actual device result...');
    } catch (error) {
      if (expired || (windowDeadline !== null && Date.now() >= windowDeadline)) { endSession(); return; }
      if ([400,403,409,413,415,422].includes(error.status)) {
        rememberAttempt('');
        if (error.status === 403) token = '';
        say(error.status === 409 ? 'The device is already testing a connection. Querying its current result...' :
          'The device rejected this request. Check the inputs and current session before trying again.');
      } else {
        say('Connection result is unknown. Rejoin the same hotspot and query the device. The request will not be sent again automatically.');
      }
    } finally {
      submitting = false;
      updateButton();
      schedule(0);
    }
  });
  refresh();
})();
</script>
</body></html>)FDHTML";
