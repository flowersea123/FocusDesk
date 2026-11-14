const byId = id => document.getElementById(id);
const outlookNotice = byId('outlook-notice');
const outlookForm = byId('connect-form');
const setup = byId('app-registration');
let submitting = false;
let initial = true;
let statusSerial = 0;

const phaseLabels = { baseline: '正在建立收件箱起点', incremental: '正在监听新邮件', error: '同步需要处理', disconnected: '等待连接' };
const actionLabels = { added: '已加入待办', existing: '待办已存在', full: '待办已满，等待重试', review: '待核对', retry: '等待重试', pending: '等待写入', expired: '已过期' };
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
      line(row, 'p', [action.title, date && date + '（北京）', actionLabels[action.status], action.reason].filter(Boolean).join(' · '));
    }
    list.append(row);
  }
  if (!messages.length) line(list, 'p', '连接后收到的新邮件会显示在这里。', 'hint');
}
async function refreshOutlook() {
  const ticket = ++statusSerial;
  try {
    const res = await fetch('/api/outlook/status', { cache: 'no-store' });
    if (res.status === 404) { byId('outlook').hidden = true; return; }
    const state = await res.json();
    if (!res.ok) throw new Error(state.error || '邮箱状态读取失败。');
    if (ticket !== statusSerial) return;
    const sync = state.sync || {};
    byId('outlook-state').textContent = state.connected
      ? [sync.syncing ? '正在同步' : (phaseLabels[sync.phase] || '已连接'), sync.lastSyncAt && '最近同步 ' + time(sync.lastSyncAt), sync.lastError].filter(Boolean).join(' · ')
      : '尚未连接';
    outlookForm.hidden = state.connected;
    byId('outlook-inbox').hidden = !state.connected;
    byId('outlook-reconnect').hidden = !(state.connected && sync.phase === 'error');
    byId('redirect-uri').textContent = state.redirectUri || 'http://localhost:' + location.port + '/auth/callback';
    if (initial) {
      byId('client-id').value = state.clientId || '';
      byId('tenant-id').value = state.tenantId === 'organizations' ? '' : state.tenantId || '';
      setup.open = !state.configured;
      initial = false;
    }
    showHistory(state.connected ? sync.history || [] : []);
  } catch (err) {
    byId('outlook-state').textContent = '状态读取失败 · ' + err.message;
  }
}
async function outlookAction(path, data = {}) {
  const response = await fetch('/api/outlook/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
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
    const tenantId = byId('tenant-id').value.trim();
    const { authorizationUrl } = await outlookAction('connect', { clientId, tenantId });
    location.assign(authorizationUrl);
  });
});
byId('outlook-reconnect').addEventListener('click', () => act(async () => {
  const { authorizationUrl } = await outlookAction('connect');
  location.assign(authorizationUrl);
}));
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
