const byId = id => document.getElementById(id);
const outlookNotice = byId('outlook-notice');
const outlookForm = byId('connect-form');
const setup = byId('app-registration');
let submitting = false;
let initial = true;
let statusSerial = 0;
let lastConnected = false;
let connectedType;
let historyLimit = 60;
let renderedHistory = '';

const accountOptions = {
  personal: {
    name: '个人 Outlook',
    hint: '支持个人 Microsoft 账户的应用 ID 可以直接使用。',
    audience: '账户类型选择「仅限个人 Microsoft 账户」，或选择同时支持组织和个人 Microsoft 账户的选项。',
    ids: '从应用「概述」复制应用程序（客户端）ID，填入上方。',
  },
  organization: {
    name: '学校或工作邮箱',
    hint: '单租户应用填写两个 ID。多租户应用可留空租户 ID。',
    audience: '使用学校或工作目录注册，选「仅此组织目录中的帐户」。组织限制注册时，可向 IT 索取已注册应用的 ID。',
    ids: '从应用「概述」复制应用程序（客户端）ID 和目录（租户）ID，填入上方。',
  },
};
function configuredType(state) {
  if (!state.connected && !state.configured) return 'personal';
  if (state.accountType === 'personal' || state.accountType === 'organization') return state.accountType;
  // Older configured registrations were for organizational accounts.
  return state.tenantId === 'consumers' ? 'personal' : 'organization';
}
function selectType(type) {
  const option = accountOptions[type];
  outlookForm.elements.accountType.value = type;
  byId('tenant-field').hidden = type === 'personal';
  byId('tenant-id').disabled = type === 'personal';
  byId('registration-hint').textContent = option.hint;
  byId('registration-audience').textContent = option.audience;
  byId('registration-ids').textContent = option.ids;
  byId('outlook-login').textContent = '登录' + option.name;
}
for (const radio of outlookForm.elements.accountType) {
  radio.addEventListener('change', () => { selectType(radio.value); outlookNotice.textContent = ''; });
}

const phaseLabels = { baseline: '正在建立收件箱起点', incremental: '正在监听新邮件', error: '同步需要处理', disconnected: '等待连接' };
const actionLabels = { added: '已导入', existing: '已有同源事项', full: '待办已满，等待重试', review: '待核对', retry: '等待重试', pending: '等待写入', expired: '已过期' };
const mailLabels = { queued: '等待分析', retry: '等待重试', unavailable: '无法读取', review: '待核对', processed: '已分析' };

function time(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
function line(parent, tag, text, cls) {
  const child = document.createElement(tag);
  if (cls) child.className = cls;
  child.textContent = text;
  parent.append(child);
}
function showHistory(messages) {
  const list = byId('outlook-history');
  const signature = JSON.stringify(messages);
  if (signature === renderedHistory || (messages.length && (savingMailPlans.size || list.contains(document.activeElement) && document.activeElement.matches('input')))) return;
  renderedHistory = signature;
  list.replaceChildren();
  for (const mail of messages) {
    const row = document.createElement('article');
    row.className = 'item';
    line(row, 'h3', mail.subject || '无主题邮件');
    line(row, 'p', [time(mail.receivedAt), mailLabels[mail.status]].filter(Boolean).join(' · '), 'hint');
    if (mail.summary) line(row, 'p', mail.summary, 'summary');
    if (mail.reason) line(row, 'p', mail.reason, 'hint');
    for (const action of mail.actions || []) {
      const date = time(action.dueAt);
      const section = document.createElement('section'); section.className = 'mail-action';
      if (mail.actions.length > 1) line(section, 'h4', action.deviceTitle);
      line(section, 'p', [date && '截止时间 ' + date + '（北京）', action.reason || (!action.entry && actionLabels[action.status])].filter(Boolean).join(' · '), 'hint');
      section.append(mailPlanForm(action, values => outlookAction('plan', { messageId: mail.id, actionId: action.id, ...values }),
        document.getElementById('hub-link').href));
      row.append(section);
    }
    list.append(row);
  }
  if (!messages.length) line(list, 'p', '连接后收到的新邮件会显示在这里。', 'hint');
}
async function refreshOutlook() {
  const ticket = ++statusSerial;
  try {
    const res = await fetch('/api/outlook/status' + (historyLimit === 60 ? '' : '?limit=' + historyLimit), { cache: 'no-store' });
    if (res.status === 404) { byId('outlook').hidden = true; return; }
    const state = await res.json();
    if (!res.ok) throw new Error(state.error || '邮箱状态读取失败。');
    if (ticket !== statusSerial) return;
    const sync = state.sync || {};
    const type = configuredType(state);
    connectedType = state.connected ? type : undefined;
    byId('outlook-title').textContent = state.connected ? accountOptions[type].name : '连接 Outlook 邮箱';
    byId('outlook-reconnect').textContent = '重新登录' + accountOptions[type].name;
    byId('outlook-state').textContent = state.connected
      ? [sync.syncing ? '正在同步' : (phaseLabels[sync.phase] || '已连接'), sync.lastSyncAt && '最近同步 ' + time(sync.lastSyncAt), sync.lastError].filter(Boolean).join(' · ')
      : '尚未连接';
    outlookForm.hidden = state.connected;
    byId('outlook-inbox').hidden = !state.connected;
    byId('outlook-reconnect').hidden = !(state.connected && sync.phase === 'error');
    byId('redirect-uri').textContent = state.redirectUri || 'http://localhost:' + location.port + '/auth/callback';
    if (initial || state.connected !== lastConnected) {
      byId('client-id').value = state.clientId || '';
      byId('tenant-id').value = type === 'organization' && state.tenantId !== 'organizations' ? state.tenantId || '' : '';
      selectType(type);
      setup.open = !state.configured;
      initial = false;
    }
    if (lastConnected && !state.connected) { mailPlanDrafts.clear(); historyLimit = 60; renderedHistory = ''; }
    lastConnected = state.connected;
    byId('outlook-more').hidden = !(sync.historyCount > (sync.history?.length || 0));
    showHistory(state.connected ? sync.history || [] : []);
  } catch (err) {
    byId('outlook-state').textContent = '状态读取失败 · ' + err.message;
  }
}
async function outlookAction(path, data = {}) {
  const response = await fetch('/api/outlook/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || '操作失败，请重试。'), {current: result.current, planRevision: result.planRevision});
  return result;
}
async function act(operation) {
  if (submitting) return;
  submitting = true;
  outlookNotice.textContent = '';
  const buttons = Array.from(byId('outlook').querySelectorAll('button'));
  buttons.forEach(button => { button.disabled = true; });
  try { await operation(); }
  catch (err) { outlookNotice.textContent = err.message; }
  finally { submitting = false; buttons.forEach(button => { button.disabled = false; }); await refreshOutlook(); }
}
outlookForm.addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const clientId = byId('client-id').value.trim();
    if (!clientId) { setup.open = true; byId('client-id').focus(); throw new Error('请先填写应用程序（客户端）ID。'); }
    const accountType = outlookForm.elements.accountType.value;
    const settings = { accountType, clientId };
    if (accountType === 'organization') settings.tenantId = byId('tenant-id').value.trim();
    const { authorizationUrl } = await outlookAction('connect', settings);
    location.assign(authorizationUrl);
  });
});
byId('outlook-reconnect').addEventListener('click', () => act(async () => {
  const { authorizationUrl } = await outlookAction('connect', { accountType: connectedType });
  location.assign(authorizationUrl);
}));
byId('outlook-more').addEventListener('click', () => { historyLimit += 60; refreshOutlook(); });
byId('outlook-sync').addEventListener('click', () => act(() => outlookAction('sync')));
byId('outlook-disconnect').addEventListener('click', () => act(() => outlookAction('disconnect')));
if (location.hash.startsWith('#outlook-error=')) {
  const query = new URLSearchParams(location.hash.slice('#outlook-'.length));
  outlookNotice.textContent = query.get('error');
  history.replaceState(null, '', '/');
} else if (location.hash === '#outlook-connected') {
  outlookNotice.textContent = '微软授权成功，正在准备收件箱。';
  history.replaceState(null, '', '/');
}
refreshOutlook();
setInterval(() => { if (!document.hidden && !submitting) refreshOutlook(); }, 10_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOutlook(); });
