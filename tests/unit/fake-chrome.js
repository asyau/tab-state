// Minimal in-memory stand-in for the chrome.* APIs the tracker uses, plus a controllable clock.

function area() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { data = {}; },
    _dump: () => data,
  };
}

export function createFakeChrome() {
  let nextTabId = 1;
  const tabs = new Map();
  const env = {
    now: 1_700_000_000_000,
    idle: 'active',
    browserFocused: true,
    focusedWindowId: 1,
  };

  const chrome = {
    storage: { local: area(), session: area() },
    idle: { queryState: async () => env.idle },
    windows: {
      async getLastFocused() {
        return { id: env.focusedWindowId, focused: env.browserFocused };
      },
    },
    tabs: {
      async query(q = {}) {
        return [...tabs.values()].filter((t) =>
          (q.active === undefined || t.active === q.active) &&
          (q.windowId === undefined || t.windowId === q.windowId)).map((t) => ({ ...t }));
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab');
        return { ...tabs.get(id) };
      },
      async create({ url, active = true, windowId = 1 }) {
        const tab = { id: nextTabId++, url: '', pendingUrl: url, title: '', windowId, active: false, pinned: false };
        tabs.set(tab.id, tab);
        if (active) env.activate(tab.id);
        return { ...tab };
      },
      async remove(ids) {
        for (const id of [].concat(ids)) tabs.delete(id);
      },
    },
  };

  env.chrome = chrome;
  env.tabs = tabs;
  env.openTab = ({ url, title = url, windowId = 1, active = false }) => {
    const tab = { id: nextTabId++, url, title, windowId, active: false, pinned: false };
    tabs.set(tab.id, tab);
    if (active) env.activate(tab.id);
    return { ...tab };
  };
  env.activate = (id) => {
    const target = tabs.get(id);
    for (const t of tabs.values()) if (t.windowId === target.windowId) t.active = false;
    target.active = true;
  };
  env.navigate = (id, url, title = url) => {
    Object.assign(tabs.get(id), { url, title, pendingUrl: undefined });
    return { ...tabs.get(id) };
  };
  env.commit = (id) => {
    const t = tabs.get(id);
    Object.assign(t, { url: t.pendingUrl, pendingUrl: undefined, title: t.pendingUrl });
    return { ...t };
  };
  env.tab = (id) => ({ ...tabs.get(id) });
  env.advance = (ms) => { env.now += ms; };
  /** Browser restart: new tab ids, session storage wiped. */
  env.restartBrowser = (urls) => {
    tabs.clear();
    chrome.storage.session.clear();
    return urls.map((url, i) => env.openTab({ url, active: i === 0 }));
  };
  return env;
}
