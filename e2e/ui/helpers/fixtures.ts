import { test as base, expect } from '@playwright/test';

/**
 * Shared UI-e2e test fixture.
 *
 * Points every portal page at the test Router BEFORE its bundle evaluates
 * routerManager's module-level seed. Without this, `window.__SOLO_ROUTER__` is
 * undefined (vite serves no `config.js` in e2e), so `getRouterAddresses()` falls
 * back to the dead SSL proxy at `https://localhost:8800/` — and every portal RPC
 * silently hits a dead host (empty service lists, blank editors, redirects).
 *
 * This mirrors what the deployed `run.sh` injects via a generated `config.js`.
 * Inject at the CONTEXT level so it covers the default page plus any
 * `context.newPage()`, and composes cleanly with `test.use({ storageState })`.
 *
 * Use this `test`/`expect` instead of `@playwright/test` in every spec that drives
 * a real portal (system + operator). Route-mocked mobile specs don't need it
 * (they intercept fetch and never reach a Router).
 */
const TEST_ROUTER = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript((url) => {
      (window as any).__SOLO_ROUTER__ = url;
    }, TEST_ROUTER);
    await use(context);
  },
});

export { expect };
