// On first install the extension opens its dashboard in a new, *active* tab (background.js,
// onInstalled with reason 'install'). Every e2e run starts from a fresh profile, so that install
// happens right as the script starts browsing — and if the welcome tab opens a moment after the
// script's first page, it takes focus and that page accrues ~0s while the script "reads" it (it
// then correctly lands in Ghost). Scripts wait for the welcome tab and close it before browsing.
//
// This polls the actual condition (the tab exists) instead of sleeping a guessed amount.

export async function dismissWelcomeTab(sw, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Right after Playwright first sees the worker, its chrome.* APIs may not be bound yet
    // (`chrome.runtime` undefined) — that's "not ready", so keep polling.
    const closed = await sw.evaluate(async () => {
      if (!globalThis.chrome?.runtime?.getURL || !chrome.tabs) return 0;
      const url = chrome.runtime.getURL('ui/dashboard.html');
      const tabs = (await chrome.tabs.query({})).filter((t) => (t.url || t.pendingUrl) === url);
      await Promise.all(tabs.map((t) => chrome.tabs.remove(t.id)));
      return tabs.length;
    }).catch(() => 0);
    if (closed) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the install-time welcome tab never opened within ${timeoutMs}ms`);
}
