// Only the isolated, top-level ChatGPT content script can use this fixed loopback endpoint.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || new URL(sender.url).origin !== 'https://chatgpt.com') return;
  if (!message || !['status','running','finished','interrupted'].includes(message.action)) return;
  async function send() {
    const { port = 8787 } = await chrome.storage.local.get('port');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const body = message.action === 'status' ? {action:'status'} : {action:message.action, session:message.session, id:message.id};
    if (message.action !== 'status' && message.conversationId) {
      body.conversationId = message.conversationId;
      for (const field of ['conversationTurnId', 'conversationTitle', 'userExcerpt', 'assistantExcerpt']) {
        if (typeof message[field] === 'string') body[field] = message[field];
      }
    }
    const response = await fetch('http://127.0.0.1:' + port + '/api/v1/ai-browser', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      cache:'no-store', credentials:'omit', redirect:'error', signal:AbortSignal.timeout(3500),
    });
    if (!response.ok) return null;
    return (await response.json()).session ?? null;
  }
  send().then(reply, () => reply(null));
  return true;
});
