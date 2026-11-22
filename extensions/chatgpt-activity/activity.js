(() => {
  const stopControl = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="停止生成"]';
  const excluded = 'script,style,svg,img,button,details,textarea,[hidden],[inert],[aria-hidden="true"],.sr-only,[data-message-channel="analysis"],[data-message-channel="commentary"],[data-message-type="reasoning"],[data-testid*="thought" i],[data-testid*="reason" i],[data-testid*="thinking" i],[data-testid*="tool-" i],[data-message-author-role="tool"],[data-message-author-role="system"]';
  let session = null, run = null, route = location.pathname, observer, ticking = false, scheduled;
  let generation = 0, writes = Promise.resolve(), previousRootUser, previousButton;
  const send = message => chrome.runtime.sendMessage(message).catch(() => null);

  function clip(text, max) {
    const clean = text.replace(/https?:\/\/\S+/giu, '链接')
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, '')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\s]+/gu, ' ').trim();
    return clean.length <= max ? clean : clean.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
  }
  function visible(element) {
    return !element.closest(excluded) &&
      element.checkVisibility({visibilityProperty:true, opacityProperty:true});
  }
  function snippet(element) {
    if (!element || !visible(element)) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(excluded) || getComputedStyle(node).display !== 'contents' && !visible(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    let text = '', node;
    // Bound both traversed text and output; never copy a whole conversation or retain DOM fragments.
    for (let n = 0; n < 256 && text.length < 640 && (node = walker.nextNode()); n++) {
      text += ' ' + node.nodeValue.slice(0, 640 - text.length);
    }
    return clip(text, 320);
  }
  function chatKey(path) {
    return path.match(/(?:^|\/)c\/([a-zA-Z0-9_-]{1,128})\/?$/)?.[1];
  }
  async function hashedId(key, message = false) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((message ? 'chatgpt.com/message/' : 'chatgpt.com/c/') + key));
    return (message ? 'chatgpt-msg-' : 'chatgpt-') + Array.from(new Uint8Array(bytes).subarray(0,12), n => n.toString(16).padStart(2,'0')).join('');
  }
  function metadata(turn, action, path) {
    const main = document.querySelector('main');
    if (!main) return {};
    const users = main.querySelectorAll('[data-message-author-role="user"]');
    const user = Array.from(users).findLast(visible);
    if (!user) return {};
    // A changed last user node after navigation must not supply another conversation's answer.
    const token = user.getAttribute('data-message-id');
    const prompt = snippet(user);
    if (turn.user && turn.user.deref() !== user && (!token || turn.userToken !== token) &&
        (!prompt || prompt !== turn.userExcerpt)) return {};
    turn.user = new WeakRef(user);
    turn.userToken = token;
    if (!chatKey(path)) {
      const previousUser = previousRootUser?.user.deref();
      if (previousUser && previousUser !== user && main.contains(previousUser) &&
          previousUser.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING) turn.localId = previousRootUser.id;
      previousRootUser = {user:turn.user, id:turn.localId};
    }
    const fields = {};
    if (prompt) { turn.userExcerpt = prompt; fields.userExcerpt = prompt; }
    const title = chatKey(path) && clip(document.title.replace(/^ChatGPT\s*[-–—|·:]\s*|\s*[-–—|·:]\s*ChatGPT$/giu,''),100);
    if (title && !/^(ChatGPT|New chat|新聊天|新对话|ChatGPT Chat)$/iu.test(title)) fields.conversationTitle = title;
    if (action === 'finished') {
      const reply = Array.from(main.querySelectorAll('[data-message-author-role="assistant"]')).findLast(visible);
      if (reply && user.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) {
        // Only the final answer body within the current assistant message. Unrecognised UI supplies no excerpt.
        const body = Array.from(reply.querySelectorAll('.markdown,[data-testid="final-answer"]')).findLast(visible);
        const answer = snippet(body);
        if (answer) fields.assistantExcerpt = answer;
      }
    }
    return fields;
  }
  function report(action, turn, readText = false) {
    const epoch = session, path = location.pathname, sequence = generation;
    async function write() {
      if (!epoch || session !== epoch && action !== 'interrupted') return;
      const key = chatKey(path);
      let fields = {};
      if (readText && location.pathname === path && sequence === generation) {
        // The recorder may have stopped since the tab's last heartbeat. Check again before reading text.
        if (await send({action:'status'}) !== epoch) return;
        if (session === epoch && location.pathname === path && sequence === generation) fields = metadata(turn,action,path);
      }
      if (action !== 'interrupted' && key && turn.key !== key) {
        turn.conversationId = await hashedId(key); turn.key = key;
      }
      if (!turn.conversationTurnId && turn.userToken && /^[A-Za-z0-9_-]{1,128}$/.test(turn.userToken)) {
        turn.conversationTurnId = await hashedId(turn.userToken, true);
      }
      await send({action, id:turn.id, session:epoch, conversationId:turn.conversationId ?? turn.localId,
        ...(turn.conversationTurnId ? {conversationTurnId:turn.conversationTurnId} : {}), ...fields});
    }
    writes = writes.then(write, write).catch(() => {});
  }
  function observe(heartbeat = false) {
    if (!session) return;
    const path = location.pathname;
    const promoted = (route === '/' || /^\/g\/[^/]+\/?$/.test(route)) && chatKey(path);
    if (route !== path && !promoted) {
      generation++;
      previousButton = run?.button.deref();
      if (run) report('interrupted', run);
      run = null; previousRootUser = undefined;
    }
    route = path;
    const button = document.querySelector(stopControl);
    const generating = button && !button.disabled && button.getClientRects().length > 0;
    // An SPA can change the URL before replacing the previous conversation's controls.
    if (generating && button === previousButton) return;
    previousButton = undefined;
    if (generating && !run) {
      generation++;
      run = {button:new WeakRef(button), id:crypto.randomUUID(), localId:'chatgpt-local-' + crypto.randomUUID()};
      report('running',run,true);
    } else if (!generating && run) {
      report('finished', run,true); run = null;
    } else if (run && (heartbeat || promoted)) report('running',run);
  }
  function changed(records) {
    // Streaming text does not schedule a DOM read. Lifecycle controls and a heartbeat drive updates.
    if (scheduled || !records.some(record => record.type === 'attributes' ?
      record.target.tagName === 'BUTTON' : [...record.addedNodes,...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(stopControl) || node.querySelector(stopControl))))) return;
    scheduled = setTimeout(() => { scheduled = null; observe(); }, 100);
  }
  function setSession(next) {
    if (session === next) return;
    generation++; observer?.disconnect(); clearTimeout(scheduled); scheduled = null; run = null; session = next;
    previousRootUser = previousButton = undefined;
    route = location.pathname;
    if (session) {
      observer = new MutationObserver(changed);
      observer.observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['data-testid','aria-label','disabled']});
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try { setSession(await send({action:'status'})); observe(true); } finally { ticking = false; }
  }
  addEventListener('pagehide', () => { if (run) report('interrupted', run); setSession(null); });
  addEventListener('pageshow', tick); addEventListener('popstate', () => observe());
  document.addEventListener('visibilitychange', tick);
  setInterval(tick, 10_000);
  tick();
})();
