import fs from 'fs';
import path from 'path';
import { loginUser } from './helpers/api';

// Router the portal should call (direct HTTP, not the SSL proxy the portal defaults to).
const ROUTER_URL = (process.env.SOLO_ROUTER_URL || 'http://localhost:8600') + '/';
const OPERATOR_URL = process.env.OPERATOR_URL || 'http://localhost:3600';
const STATE_DIR = path.join(__dirname, 'state');

// Write a Playwright storageState that points the operator portal at the test router and,
// when available, drops in a session token so tests start logged in. Always written (even
// token-less) so the storageState path exists — token-less just redirects to /login, which
// the smoke test reports clearly instead of crashing on a missing file.
function writeOperatorState(token?: string) {
  const localStorage = [
    { name: 'solomind:router_addresses', value: JSON.stringify([{ url: ROUTER_URL, name: 'Test' }]) },
    { name: 'solomind:current_router_index', value: '0' },
    ...(token ? [{ name: 'op_session_token', value: token }] : []),
  ];
  const state = { cookies: [], origins: [{ origin: OPERATOR_URL, localStorage }] };
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, 'operator.json'), JSON.stringify(state, null, 2));
}

export default async function globalSetup() {
  // Escape hatch: a pre-seeded session token (e.g. deploy/seed-bots.js's solo-dev-admin)
  // skips login entirely — easiest against a dev stack.
  const seedToken = process.env.SOLO_E2E_TOKEN;
  if (seedToken) {
    writeOperatorState(seedToken);
    console.log('[ui-setup] SOLO_E2E_TOKEN set — wrote operator state without login');
    return;
  }

  // Otherwise log in a real operator user (must be registered first — see .env.example).
  const user = process.env.TEST_USER;
  const pass = process.env.TEST_PASSWORD;
  if (!user || !pass) {
    console.warn('[ui-setup] no SOLO_E2E_TOKEN and no TEST_USER/TEST_PASSWORD — tests will redirect to /login');
    writeOperatorState();
    return;
  }
  try {
    const token = await loginUser(user, pass);
    writeOperatorState(token);
    console.log(`[ui-setup] operator state saved (logged in as ${user})`);
  } catch (err: any) {
    console.warn(`[ui-setup] operator login failed (${err.message}) — tests will redirect to /login`);
    writeOperatorState();
  }
}
