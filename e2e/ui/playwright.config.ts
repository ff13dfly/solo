import { defineConfig } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Load .env without external dependency (??= keeps existing process.env values intact)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

// Auto-serve the two stateless portals (vite) so `npx playwright test` is one command —
// the septopus webServer pattern. The STATEFUL mesh is OPT-IN (UI_E2E_BOOT_MESH=1): the
// harness reuses any router/redis already on its ports, so booting it transparently would
// cross-wire with a running dev stack (and admin/changeme login would fail against dev).
// CI sets the flag (clean runner); locally, run your own isolated mesh OR set the flag with
// an isolated REDIS_URL. `reuseExistingServer` makes every entry a no-op if it's already up.
const READY_PORT = process.env.UI_MESH_READY_PORT || '8699';
const webServer: any[] = [
  {
    command: 'npx vite --port 9200',
    cwd: path.join(__dirname, '../../portal/system'),
    url: 'http://localhost:9200/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  {
    command: 'npx vite --port 9300',
    cwd: path.join(__dirname, '../../portal/operator'),
    url: 'http://localhost:9300/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
];
if (process.env.UI_E2E_BOOT_MESH === '1') {
  // Prepend so the mesh (and its admin seed) is ready before global-setup's loginAdmin runs.
  webServer.unshift({
    command: 'node scripts/meshup.js',
    cwd: __dirname,
    url: `http://127.0.0.1:${READY_PORT}/`,
    reuseExistingServer: true,
    timeout: 180_000,
  });
}

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },

  webServer,

  projects: [
    {
      name: 'system',
      testDir: './tests/system',
      use: { baseURL: process.env.SYSTEM_PORTAL_URL || 'http://localhost:9200' },
    },
    {
      name: 'operator',
      testDir: './tests/operator',
      use: { baseURL: process.env.OPERATOR_PORTAL_URL || 'http://localhost:9300' },
    },
  ],
});
