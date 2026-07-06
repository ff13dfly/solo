import { defineConfig } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Load .env without a dependency (??= keeps any value already in process.env).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

// Where the operator portal is served. Default = run.sh's PORTAL_OPERATOR_PORT (3600).
// Point at your vite dev port (e.g. 5173) when testing the live source instead.
const OPERATOR_URL = process.env.OPERATOR_URL || 'http://localhost:3600';

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

  projects: [
    {
      name: 'operator',
      testDir: './tests/operator',
      use: { baseURL: OPERATOR_URL },
    },
  ],
});
