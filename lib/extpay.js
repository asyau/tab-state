// Thin wrapper around the vendored ExtPay client (see vendor/extpay.js) so the rest of the
// codebase never imports that file directly or repeats the extension id.
//
// PRO_EXTENSION_ID is a placeholder. ExtPay's "no server needed" design means the client library
// talks straight to extensionpay.com using an id *you* register there — there is no real "tab-state"
// id until you sign up at https://extensionpay.com and create one (see ../pro-proxy/README.md).
// Until then this loads fine but every call just reports an unpaid, unregistered user.
export const PRO_EXTENSION_ID = 'tab-state';

// Off until the Pro tier is really live: you've registered an id at extensionpay.com (put it in
// PRO_EXTENSION_ID above) and deployed pro-proxy/. While off, Settings doesn't offer "Tab State
// Pro" at all — a store reviewer (or a user) clicking a provider that can't work, with an upgrade
// button pointing at an unregistered payment page, reads as broken or misleading functionality.
export const PRO_TIER_ENABLED = false;

// Loaded lazily, via dynamic import, rather than a normal top-level import: the vendored client
// bundles webextension-polyfill, whose setup code throws immediately — at *module load* time, not
// when ExtPay() is actually called — if `chrome.runtime.id` isn't present. That's true in a real
// extension page, but not in this project's unit tests (which import ai/providers.js without a
// fake chrome.runtime, since most of it needs none). A normal `import ExtPay from './vendor/...'`
// at the top of this file would make importing ai/providers.js itself crash every test file, even
// ones that never touch the hosted provider. Dynamic import defers that load — and that crash
// risk — until something actually calls getExtPay(), which only happens from a real extension
// page (Settings/dashboard), same as the Nano provider never touching the service worker.
let instance = null;
export async function getExtPay() {
  if (!instance) {
    const { default: ExtPay } = await import('./vendor/extpay.js');
    instance = ExtPay(PRO_EXTENSION_ID);
  }
  return instance;
}

/** For tests only: inject a fake instance instead of dynamically loading the real vendored client
 * (which needs a real chrome.runtime.id, i.e. a real extension page — see the comment above).
 * Pass null to reset back to the real thing. */
export function __setExtPayForTests(fake) {
  instance = fake;
}
