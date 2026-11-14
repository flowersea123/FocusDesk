import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PublicClientApplication } from '@azure/msal-node';

const microsoft = 'https://login.microsoftonline.com';
// MSAL adds openid, profile and offline_access to the interactive request. Graph returns
// short scope names on its tokens; request the same form for silent cache lookups.
const scopes = ['Mail.Read'];
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const personalTenant = '9188040d-6c67-4c5b-b112-36a304b66dad';
const hash = value => createHash('sha256').update(value).digest('hex');

class OutlookAuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function authError(error) {
  if (error instanceof OutlookAuthError) return error;
  // Provider error descriptions can contain user information or the authorization code.
  const code = error?.errorCode;
  if (['interaction_required', 'consent_required', 'login_required', 'invalid_grant', 'no_tokens_found',
    'no_account_in_silent_request', 'token_refresh_required', 'refresh_token_expired'].includes(code)) {
    return new OutlookAuthError(401, 'Microsoft 要求重新登录。请重新连接学校 Outlook。');
  }
  if (['invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope'].includes(code)) {
    return new OutlookAuthError(400, '请核对 Entra 应用的租户、客户端 ID、桌面回调地址和委托权限。');
  }
  if (code === 'access_denied') return new OutlookAuthError(403, 'Microsoft 未授予邮件读取权限。如学校要求审批，请联系学校管理员。');
  return new OutlookAuthError(503, 'Microsoft 登录服务暂时无法完成请求，请稍后重试。');
}

const vaultMessage = '系统凭据库不可用。请解锁 macOS 钥匙串、Windows 凭据管理器或 Linux Secret Service，再重试。';

function registration(clientId, tenantId) {
  const client = String(clientId ?? '').trim().toLowerCase();
  const tenant = String(tenantId ?? '').trim().toLowerCase() || 'organizations';
  if (!guid.test(client)) throw new OutlookAuthError(400, '请输入 Entra 应用的 Application (client) ID。');
  if (tenant !== 'organizations' && (!guid.test(tenant) || tenant === personalTenant)) {
    throw new OutlookAuthError(400, '请输入学校的 Directory (tenant) ID，多租户应用可留空。');
  }
  return { clientId: client, tenantId: tenant };
}

function callback(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OutlookAuthError(400, '试读端口无效。');
  return 'http://localhost:' + port + '/auth/callback';
}

const networkClient = {
  async sendGetRequestAsync(url, options) { return request('GET', url, options); },
  async sendPostRequestAsync(url, options) { return request('POST', url, options); },
};

async function request(method, href, options = {}) {
  const url = new URL(href);
  if (url.origin !== microsoft || url.username || url.password) throw new OutlookAuthError(502, 'Microsoft 登录服务地址异常。');
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: options.headers,
    body: method === 'POST' ? options.body : undefined,
  });
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
}

function application(settings, network) {
  return new PublicClientApplication({
    auth: { clientId: settings.clientId, authority: microsoft + '/' + settings.tenantId },
    system: { networkClient: network, disableInternalRetries: true, loggerOptions: { loggerCallback() {}, piiLoggingEnabled: false } },
  });
}

function checkMail(result) {
  if (!result?.accessToken || !result.scopes?.some(s => /^(?:https:\/\/graph\.microsoft\.com\/)?mail\.read$/i.test(s))) {
    throw new OutlookAuthError(403, 'Microsoft 未返回 Mail.Read 委托权限，请核对注册设置和学校授权。');
  }
}

function accountId(account) {
  if (!guid.test(account?.tenantId) || !guid.test(account?.localAccountId)) {
    throw new OutlookAuthError(403, 'Microsoft 未确认学校邮箱身份。');
  }
  return account.tenantId.toLowerCase() + ':' + account.localAccountId.toLowerCase();
}

function validateSignIn(result, attempt, now) {
  const claims = result.idTokenClaims;
  const id = accountId(result.account);
  const tenant = result.account.tenantId.toLowerCase();
  const seconds = Math.floor(now / 1000);
  if (!claims || claims.nonce !== attempt.nonce || claims.aud !== attempt.clientId ||
      claims.iss !== microsoft + '/' + tenant + '/v2.0' || claims.tid?.toLowerCase() !== tenant ||
      claims.oid?.toLowerCase() !== result.account.localAccountId.toLowerCase() || tenant === personalTenant ||
      (attempt.tenantId !== 'organizations' && tenant !== attempt.tenantId) ||
      !Number.isFinite(claims.exp) || claims.exp <= seconds - 60 ||
      !Number.isFinite(claims.nbf) || claims.nbf > seconds + 60) {
    throw new OutlookAuthError(403, 'Microsoft 返回的学校账号与当前登录请求不匹配。');
  }
  return id;
}

function defaultDirectory() {
  const home = homedir();
  const parent = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return process.env.FOCUSDESK_OUTLOOK_DATA_DIR || path.join(parent, 'FocusDesk', 'outlook');
}

async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.version !== 1 || !state.baselines || typeof state.baselines !== 'object' || Array.isArray(state.baselines) ||
        (state.sealed !== null && typeof state.sealed !== 'string')) throw new Error();
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, settings: null, baselines: {}, sealed: null };
    throw new OutlookAuthError(503, '无法读取本机 Outlook 登录记录。请检查记录目录。');
  }
}

async function saveState(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); } finally { await fd.close(); }
    await rename(temp, file);
  } catch {
    throw new OutlookAuthError(503, '无法保存本机 Outlook 登录记录，请检查目录权限和可用空间。');
  } finally { await rm(temp, { force: true }); }
}

function seal(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([iv, cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return bytes.toString('base64');
}

function unseal(key, value) {
  try {
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    const clear = Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    return JSON.parse(clear.toString('utf8'));
  } catch { throw new OutlookAuthError(503, '本机 Outlook 授权缓存无法解密。可断开后重新连接。'); }
}

/** The service owns one stateDir (protected by its process-level data lock).
 * Only the desktop frontend gets status; session() and its access token stay inside the worker. */
export function createOutlookAuth({ clientId = process.env.FOCUSDESK_OUTLOOK_CLIENT_ID,
  tenantId = process.env.FOCUSDESK_OUTLOOK_TENANT_ID, port = 5184, stateDir = defaultDirectory(),
  store, networkClient: network = networkClient, now = Date.now } = {}) {
  const file = path.resolve(stateDir, 'outlook-auth.json');
  const defaultRedirect = callback(port);
  let entry = store;
  let pending = null;
  let tail = Promise.resolve();

  // Graph refresh, account switches, and disconnect must never restore each other's old cache.
  function serial(work) {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  }

  async function vault(op, ...args) {
    try {
      if (!entry) {
        const { AsyncEntry } = await import('@napi-rs/keyring');
        const identity = process.platform === 'win32' ? file.toLowerCase() : file;
        entry = new AsyncEntry('FocusDesk Outlook', hash(identity), { linux: { store: 'secret-service' } });
      }
      return await entry[op](...args);
    } catch { throw new OutlookAuthError(503, vaultMessage); }
  }

  async function keyFor(state, create) {
    const saved = await vault('getPassword');
    if (saved && /^[a-zA-Z0-9_-]{43}$/.test(saved)) return Buffer.from(saved, 'base64url');
    if (saved || state.sealed || !create) throw new OutlookAuthError(503, '本机 Outlook 加密密钥缺失或无效。请断开后重新连接。');
    const key = randomBytes(32);
    await vault('setPassword', key.toString('base64url'));
    return key;
  }

  function publicState(state) {
    const settings = state.settings ?? { clientId: String(clientId ?? '').trim(), tenantId: String(tenantId ?? '').trim() || 'organizations' };
    return { configured: guid.test(settings.clientId), connected: Boolean(state.sealed), ...settings, redirectUri: defaultRedirect };
  }

  async function disable(state) {
    // Stop using the authorization first. Repeating disconnect also retries deleting an orphaned vault entry.
    await saveState(file, { ...state, sealed: null });
    await vault('deletePassword');
    return publicState({ ...state, sealed: null });
  }

  const auth = {
    status: () => serial(async () => publicState(await readState(file))),
    begin: (options = {}) => serial(async () => {
      const state = await readState(file);
      const defaults = publicState(state);
      const settings = registration(options.clientId ?? defaults.clientId, options.tenantId ?? defaults.tenantId);
      const redirectUri = callback(options.port ?? port);
      await keyFor(state, true); // Fail early if the platform cannot protect an offline login.
      // Save the public registration on first setup. A failed account change leaves the working session intact.
      if (!state.sealed) await saveState(file, { ...state, settings });
      const verifier = randomBytes(48).toString('base64url');
      const attempt = { ...settings, redirectUri, verifier, state: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'), expires: now() + 10 * 60_000 };
      const app = application(settings, network);
      try {
        const authorizationUrl = await app.getAuthCodeUrl({ scopes, redirectUri, state: attempt.state, nonce: attempt.nonce,
          prompt: 'select_account', codeChallengeMethod: 'S256', codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
        pending = { ...attempt, app };
        return { authorizationUrl };
      } catch (error) { throw authError(error); }
    }),
    finish: params => serial(async () => {
      const attempt = pending;
      if (!(params instanceof URLSearchParams) || !attempt || params.getAll('state').length !== 1 ||
          params.get('state') !== attempt.state || attempt.expires <= now()) {
        if (attempt && attempt.expires <= now()) pending = null;
        throw new OutlookAuthError(400, '登录请求无效或已过期，请从试读页重新连接。');
      }
      pending = null;
      if (params.has('error')) {
        if (params.get('error') === 'access_denied') throw authError({ errorCode: 'access_denied' });
        throw new OutlookAuthError(400, 'Microsoft 未完成登录，请核对学校应用配置后重新连接。');
      }
      if (params.getAll('code').length !== 1 || !params.get('code') || params.get('code').length > 16_384) {
        throw new OutlookAuthError(400, 'Microsoft 未返回有效授权码。');
      }
      const state = await readState(file);
      try {
        const result = await attempt.app.acquireTokenByCode({ scopes, code: params.get('code'), codeVerifier: attempt.verifier,
          redirectUri: attempt.redirectUri, state: attempt.state, nonce: attempt.nonce }, { state: params.get('state') });
        checkMail(result);
        const identity = validateSignIn(result, attempt, now());
        const cache = attempt.app.getTokenCache().serialize();
        if (!Object.values(JSON.parse(cache).RefreshToken ?? {}).some(token => token.secret)) {
          throw new OutlookAuthError(403, 'Microsoft 未提供离线授权，请重新连接并允许保持访问。');
        }
        const settings = registration(attempt.clientId, attempt.tenantId);
        const index = hash(identity);
        const connectedAt = state.baselines[index] ?? new Date(now()).toISOString();
        const key = await keyFor(state, true);
        const next = { version: 1, settings, baselines: { ...state.baselines, [index]: connectedAt },
          sealed: seal(key, { ...settings, identity, connectedAt, cache }) };
        await saveState(file, next);
        return publicState(next);
      } catch (error) { throw authError(error); }
    }),
    session: ({ forceRefresh = false } = {}) => serial(async () => {
      const state = await readState(file);
      if (!state.sealed) return null;
      const key = await keyFor(state, false);
      const record = unseal(key, state.sealed);
      try {
        const app = application(record, network);
        const tokens = app.getTokenCache();
        tokens.deserialize(record.cache);
        const account = (await tokens.getAllAccounts()).find(value => accountId(value) === record.identity);
        if (!account) throw new OutlookAuthError(401, '请重新连接学校 Outlook。');
        const result = await app.acquireTokenSilent({ account, scopes, forceRefresh,
          authority: microsoft + '/' + account.tenantId });
        checkMail(result);
        if (accountId(result.account) !== record.identity) throw new OutlookAuthError(401, '学校账号已变化，请重新连接。');
        const cache = tokens.serialize();
        if (cache !== record.cache) await saveState(file, { ...state, sealed: seal(key, { ...record, cache }) });
        return { accountId: record.identity, accessToken: result.accessToken, connectedAt: record.connectedAt };
      } catch (error) {
        const issue = authError(error);
        if (issue.status === 401 || issue.status === 403) await disable(state);
        throw issue;
      }
    }),
    disconnect: () => serial(async () => {
      pending = null;
      return disable(await readState(file));
    }),
  };
  auth.accessToken = async options => {
    const session = await auth.session(options);
    if (!session) throw new OutlookAuthError(401, '请先连接学校 Outlook。');
    return session.accessToken;
  };
  return auth;
}
