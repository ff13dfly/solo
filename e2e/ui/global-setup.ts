import fs from 'fs';
import path from 'path';
import { loginAdmin, loginUser } from './helpers/api';

// Router URL injected into localStorage so portals point at the test backend.
const ROUTER_URL = (process.env.SOLO_ROUTER_URL || 'http://localhost:8600') + '/';

// storageState is origin-scoped: localStorage only applies when the page's origin
// matches. These MUST track the baseURL the projects serve at (playwright.config.ts), so
// override them together. Default to the canonical portal dev ports.
const SYSTEM_ORIGIN = (process.env.SYSTEM_PORTAL_URL || 'http://localhost:9200').replace(/\/$/, '');
const OPERATOR_ORIGIN = (process.env.OPERATOR_PORTAL_URL || 'http://localhost:9300').replace(/\/$/, '');

const STATE_DIR = path.join(__dirname, 'state');

function writeState(file: string, origin: string, items: Array<{ name: string; value: string }>) {
  const state = {
    cookies: [],
    origins: [{ origin, localStorage: items }],
  };
  fs.writeFileSync(path.join(STATE_DIR, file), JSON.stringify(state, null, 2));
}

export default async function globalSetup() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  // Escape hatch for dev stacks: SOLO_E2E_TOKEN injects a pre-seeded session token
  // (e.g. deploy/seed-bots.js's `solo-dev-admin`) into BOTH portal states directly,
  // skipping the login flow — dev.sh's administrator seed has a real password that
  // isn't `changeme`, so admin.login is not an option there.
  const seedToken = process.env.SOLO_E2E_TOKEN || '';
  if (seedToken) {
    const routerItems = [
      { name: 'solomind:router_addresses',     value: JSON.stringify([{ url: ROUTER_URL, name: 'Test' }]) },
      { name: 'solomind:current_router_index', value: '0' },
    ];
    writeState('system.json', SYSTEM_ORIGIN, [
      { name: 'sys_session_token', value: seedToken },
      { name: 'sys_session_ts',    value: Date.now().toString() },
      ...routerItems,
    ]);
    writeState('operator.json', OPERATOR_ORIGIN, [
      { name: 'op_session_token', value: seedToken },
      ...routerItems,
    ]);
    console.log('[ui-setup] SOLO_E2E_TOKEN set — wrote system + operator states without login');
    return;
  }

  // System portal (admin)
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme';
  try {
    const token = await loginAdmin(adminUser, adminPass);
    writeState('system.json', SYSTEM_ORIGIN, [
      { name: 'sys_session_token', value: token },
      { name: 'sys_session_ts',    value: Date.now().toString() },
      // Point portal at test backend instead of the default SSL proxy.
      { name: 'solomind:router_addresses',    value: JSON.stringify([{ url: ROUTER_URL, name: 'Test' }]) },
      { name: 'solomind:current_router_index', value: '0' },
    ]);
    console.log('[ui-setup] system portal state saved');
  } catch (err: any) {
    console.warn(`[ui-setup] could not acquire admin token (${err.message}) — system smoke tests will redirect to login`);
  }

  // Operator portal (user)
  const testUser = process.env.TEST_USER || '';
  const testPass = process.env.TEST_PASSWORD || '';
  if (testUser && testPass) {
    try {
      const token = await loginUser(testUser, testPass);
      writeState('operator.json', OPERATOR_ORIGIN, [
        { name: 'op_session_token', value: token },
        { name: 'solomind:router_addresses',    value: JSON.stringify([{ url: ROUTER_URL, name: 'Test' }]) },
        { name: 'solomind:current_router_index', value: '0' },
      ]);
      console.log('[ui-setup] operator portal state saved');
    } catch (err: any) {
      console.warn(`[ui-setup] could not acquire user token (${err.message}) — operator smoke tests will redirect to login`);
    }
  } else {
    console.warn('[ui-setup] TEST_USER/TEST_PASSWORD not set — skipping operator auth state');
  }
}
