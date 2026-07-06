import { defineConfig } from '@playwright/test';
import path from 'path';

/**
 * Mobile chat UI e2e — ROUTE-MOCKED, no backend mesh.
 *
 * The mobile client (client/mobile) drives every action through JSON-RPC to the Router.
 * These tests intercept that boundary (helpers/mobile.ts) and serve canned replies, so the
 * client's rendering + Focus state machine can be pinned deterministically — no LLM, no mesh,
 * no Redis. Kept separate from playwright.config.ts on purpose: that config's globalSetup logs
 * into the system portal against a live mesh, which these route-mocked tests neither need nor want.
 *
 * Run:  npx playwright test --config=playwright.mobile.config.ts
 * (needs client/mobile deps installed; the webServer below boots vite on :9500)
 */
export default defineConfig({
  testDir: './tests/mobile',
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    headless: true,
    baseURL: 'http://localhost:9500',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },

  // Auto-start the mobile vite dev server (port 9500 per client/mobile/vite.config.ts).
  webServer: {
    command: 'npx vite --port 9500 --strictPort',
    cwd: path.join(__dirname, '..', '..', 'client', 'mobile'),
    url: 'http://localhost:9500',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },

  projects: [{ name: 'mobile' }],
});
