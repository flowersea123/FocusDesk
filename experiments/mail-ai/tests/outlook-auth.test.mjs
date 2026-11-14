import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOutlookAuth } from '../outlook-auth.mjs';

const clientId = '11111111-2222-3333-4444-555555555555';
const tenant = '44444444-5555-6666-7777-888888888888';
const oid = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const origin = 'https://login.microsoftonline.com';
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'focusdesk-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = { oid, tenant, now: Date.now(), calls: [], refresh: 0, claims: {}, overrides: {} };
  const store = { value: null, async getPassword() { return this.value; },
    async setPassword(key) { this.value = key; }, async deletePassword() { this.value = null; } };
  const net = {
    async sendGetRequestAsync(url) {
      assert.equal(new URL(url).origin, origin);
      if (url.includes('/discovery/instance')) {
        return { status: 200, headers: {}, body: { tenant_discovery_endpoint: origin + '/organizations/v2.0/.well-known/openid-configuration',
          metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net',
            aliases: ['login.microsoftonline.com', 'login.windows.net'] }] } };
      }
      assert.match(url, /\.well-known\/openid-configuration/);
      const authority = origin + '/{tenantid}';
      return { status: 200, headers: {}, body: { authorization_endpoint: authority + '/oauth2/v2.0/authorize',
        token_endpoint: authority + '/oauth2/v2.0/token', issuer: authority + '/v2.0',
        jwks_uri: authority + '/discovery/v2.0/keys', end_session_endpoint: authority + '/oauth2/v2.0/logout' } };
    },
    async sendPostRequestAsync(url, request) {
      assert.equal(new URL(url).origin, origin);
      const form = new URLSearchParams(request.body);
      const grant = form.get('grant_type');
      provider.calls.push({ url, form });
      if (provider.error) return { status: provider.status ?? 400, headers: {}, body: {
        error: provider.error, error_description: 'private diagnostic that must not reach the browser' } };
      const sec = Math.floor(provider.now / 1000);
      const claims = { ver: '2.0', aud: clientId, iss: origin + '/' + provider.tenant + '/v2.0',
        nbf: sec - 30, iat: sec, exp: sec + 3600, sub: 'test', tid: provider.tenant, oid: provider.oid,
        preferred_username: 'fixture@school.example', name: 'Fixture User', nonce: provider.nonce, ...provider.claims };
      const token = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode(claims) + '.fixture';
      if (grant === 'refresh_token') provider.refresh++;
      return { status: 200, headers: {}, body: {
        token_type: 'Bearer', scope: 'Mail.Read', expires_in: 3600,
        access_token: 'private-fixture-access-' + provider.refresh + '-' + 'A'.repeat(3600),
        refresh_token: 'private-fixture-refresh-' + provider.refresh + '-' + 'R'.repeat(3600),
        id_token: token, client_info: encode({ uid: provider.oid, utid: provider.tenant }), ...provider.overrides } };
    },
  };
  const make = () => createOutlookAuth({ stateDir: dir, clientId, tenantId: '', store, networkClient: net, now: () => provider.now, ...options });
  const auth = make();
  const begin = async (settings = {}) => {
    const url = new URL((await auth.begin(settings)).authorizationUrl);
    provider.nonce = url.searchParams.get('nonce');
    const params = new URLSearchParams({ code: 'private-fixture-auth-code', state: url.searchParams.get('state') });
    return { params, url };
  };
  return { dir, store, provider, make, auth, begin, file: path.join(dir, 'outlook-auth.json') };
}

test('public-client URL and token exchange use one-time state, S256 PKCE, loopback, school tenants and no secret', async t => {
  const { auth, begin, provider, store, file } = await setup(t);
  assert.equal(await auth.session(), null);
  assert.equal((await auth.status()).connected, false);
  const { url, params } = await begin();
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
  const values = url.searchParams;
  assert.equal(values.get('client_id'), clientId);
  assert.equal(values.get('response_type'), 'code');
  assert.equal(values.get('redirect_uri'), 'http://localhost:5184/auth/callback');
  assert.equal(values.get('code_challenge_method'), 'S256');
  assert.deepEqual(new Set(values.get('scope').toLowerCase().split(' ')), new Set(['mail.read', 'offline_access', 'openid', 'profile']));
  assert.match(values.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(values.get('state'), values.get('nonce'));
  assert.equal(values.has('client_secret'), false);
  await assert.rejects(auth.finish(new URLSearchParams({ state: 'wrong', code: 'irrelevant' })), { status: 400 });
  assert.equal(provider.calls.length, 0);
  assert.equal((await auth.finish(params)).connected, true);
  await assert.rejects(auth.finish(params), { status: 400 });
  assert.equal(provider.calls.length, 1);
  const { form } = provider.calls[0];
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), values.get('redirect_uri'));
  assert.equal(form.has('client_secret'), false);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), values.get('code_challenge'));
  assert.equal(store.value.length, 43);
  // Both tokens exceed Windows' per-item limit. Only a 256-bit encryption key reaches that item.
  const persisted = await readFile(file, 'utf8');
  for (const secret of [store.value, 'private-fixture', 'fixture@school', values.get('state'), oid, form.get('code_verifier')]) {
    assert.ok(!persisted.includes(secret));
    assert.ok(!JSON.stringify(await auth.status()).includes(secret));
  }
});

test('rejects stale, duplicate, cancelled and superseded callbacks before redeeming a code; persists first setup', async t => {
  const { auth, begin, provider, make } = await setup(t, { clientId: '' });
  await assert.rejects(auth.begin(), { status: 400 });
  await assert.rejects(auth.begin({ clientId, tenantId: 'bad' }), { status: 400 });
  assert.equal((await auth.status()).configured, false);
  const a = await begin({ clientId, tenantId: tenant, port: 3999 });
  assert.equal(a.url.pathname, '/' + tenant + '/oauth2/v2.0/authorize');
  assert.equal(a.url.searchParams.get('redirect_uri'), 'http://localhost:3999/auth/callback');
  assert.deepEqual(await make().status(), { configured: true, connected: false, clientId, tenantId: tenant, redirectUri: 'http://localhost:5184/auth/callback' });
  const b = await begin();
  assert.notEqual(a.params.get('state'), b.params.get('state'));
  await assert.rejects(auth.finish(a.params), { status: 400 });
  const duplicate = new URLSearchParams(b.params);
  duplicate.append('state', b.params.get('state'));
  await assert.rejects(auth.finish(duplicate), { status: 400 });
  b.params.set('error', 'access_denied');
  await assert.rejects(auth.finish(b.params), { status: 403 });
  const c = await begin();
  provider.now += 10 * 60_000;
  await assert.rejects(auth.finish(c.params), { status: 400 });
  assert.equal(provider.calls.length, 0);
});

test('cache survives restart, rotates refresh tokens, disconnects, and keeps the earliest per-mailbox baseline', async t => {
  const { auth, begin, provider, store, make } = await setup(t);
  await auth.finish((await begin()).params);
  const first = await auth.session();
  assert.equal(first.accountId, tenant + ':' + oid);
  const restarted = make();
  const resumed = await restarted.session();
  assert.deepEqual(resumed, first);
  const fresh = await restarted.session({ forceRefresh: true });
  assert.notEqual(fresh.accessToken, first.accessToken);
  assert.equal(fresh.accountId, first.accountId);
  const freshAgain = await make().session({ forceRefresh: true });
  assert.notEqual(freshAgain.accessToken, fresh.accessToken);
  assert.match(provider.calls.filter(c => c.form.get('grant_type') === 'refresh_token').at(-1).form.get('refresh_token'), /private-fixture-refresh-1-/);
  assert.equal((await restarted.disconnect()).connected, false);
  assert.equal(store.value, null);
  assert.equal(await auth.session(), null);
  provider.now += 60_000;
  await auth.finish((await begin()).params);
  assert.equal((await auth.session()).connectedAt, first.connectedAt);
  provider.oid = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  await auth.finish((await begin()).params);
  const another = await auth.session();
  assert.notEqual(another.accountId, first.accountId);
  assert.equal(another.connectedAt, new Date(provider.now).toISOString());
});

test('no login if nonce, tenant, audience, Mail.Read or offline refresh authority are missing or misbound', async t => {
  const { auth, begin, provider } = await setup(t);
  for (const bad of [{ nonce: 'wrong' }, { aud: 'unexpected' }, { iss: 'https://elsewhere.example/v2.0' }, { nbf: 1e10 }, { exp: 100 }]) {
    provider.claims = bad;
    await assert.rejects(auth.finish((await begin()).params));
    assert.equal(await auth.session(), null);
  }
  provider.claims = {};
  await assert.rejects(auth.finish((await begin({ tenantId: '12121212-3434-5656-7878-909090909090' })).params));
  for (const missing of [{ scope: 'User.Read' }, { refresh_token: '' }]) {
    provider.overrides = missing;
    await assert.rejects(auth.finish((await begin({ tenantId: tenant })).params), { status: 403 });
    assert.equal((await auth.status()).connected, false);
  }
});

test('temporary refresh failures preserve offline authorization, revoked refresh tokens require reconnect', async t => {
  const { auth, begin, provider, store } = await setup(t);
  await auth.finish((await begin()).params);
  provider.error = 'temporarily_unavailable';
  provider.status = 503;
  await assert.rejects(auth.session({ forceRefresh: true }), err => err.status === 503 && !err.message.includes('private'));
  assert.equal((await auth.status()).connected, true);
  provider.error = 'invalid_grant';
  provider.status = 400;
  await assert.rejects(auth.session({ forceRefresh: true }), err => err.status === 401 && !err.message.includes('private'));
  assert.equal((await auth.status()).connected, false);
  assert.equal(store.value, null);
});

test('locked store and corrupt ciphertext never produce a plaintext file or an untracked session', async t => {
  const { auth, begin, store, file, make } = await setup(t);
  const get = store.getPassword;
  store.getPassword = async () => { throw Error('private diagnostics'); };
  await assert.rejects(auth.begin(), err => err.status === 503 && !err.message.includes('private'));
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  store.getPassword = get;
  await auth.finish((await begin()).params);
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.sealed = state.sealed.substring(8);
  await writeFile(file, JSON.stringify(state));
  await assert.rejects(make().session(), { status: 503 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state);
  await auth.disconnect();
  assert.equal(await make().session(), null);
});
