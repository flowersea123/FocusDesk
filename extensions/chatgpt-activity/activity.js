(() => {
  const stopControl = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="停止生成"]';
  let session = null, run = null, route = location.pathname, observer, ticking = false, scheduled;
  let writes = Promise.resolve();
  const send = message => chrome.runtime.sendMessage(message).catch(() => null);
  function report(action, id) {
    const message = {action, id, session};
    writes = writes.then(() => send(message), () => send(message));
  }
  function observe(heartbeat = false) {
    if (!session) return;
    const path = location.pathname;
    // The first message assigns a conversation URL to a new, already-generating chat.
    if (run && route !== path && !(route === '/' && path.startsWith('/c/'))) {
      report('interrupted', run); run = null;
    }
    route = path;
    const button = document.querySelector(stopControl);
    const generating = button && !button.disabled && button.getClientRects().length > 0;
    if (generating && !run) { run = crypto.randomUUID(); report('running', run); }
    else if (!generating && run) { report('finished', run); run = null; }
    else if (run && heartbeat) report('running', run);
  }
  function changed(records) {
    // Ignore streamed text and changes within answer paragraphs. Recheck only when controls
    // are added, removed or relabelled. Coalesce a burst of React commits into one check.
    if (scheduled || !records.some(record => record.type === 'attributes' ?
      record.target.tagName === 'BUTTON' : [...record.addedNodes,...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(stopControl) || node.querySelector(stopControl))))) return;
    scheduled = setTimeout(() => { scheduled = null; observe(); }, 100);
  }
  function setSession(next) {
    if (session === next) return;
    observer?.disconnect(); clearTimeout(scheduled); scheduled = null; run = null; session = next;
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
