import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

/**
 * fulfillment↔nexus linkage on the operator portal: a profile card's SENTINELS
 * section lists the sentinels watching it, with the scope badge (pinned vs
 * stream-wide) derived from the guard's profileId pin.
 *
 * Needs a session whose permit can read nexus.sentinel.list (the section hides
 * gracefully otherwise) — run with SOLO_E2E_TOKEN (dev) or an admin-permit user.
 */

test.use({ storageState: path.join(__dirname, '../../state/operator.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';
const TS = Date.now();
const PROFILE_ID = `e2e_watch_${TS}`;
const PROFILE_NAME = `E2E Watchers ${TS}`;
const SENTINEL_NAME = `E2E Pinned Watcher ${TS}`;

// Privileged SETUP token. nexus.sentinel.create is admin-gated (sentinels are managed in
// the system portal, not by operators — an operator session gets Unauthorized), so the
// fixture provisions the watched sentinel + profile with the ADMIN session. The PAGE under
// test still runs as the operator (storageState above); the operator's permit can READ
// nexus.sentinel.list, which is all the watchers section needs.
function getToken(): string {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../state/system.json'), 'utf8')
  );
  return state.origins[0].localStorage.find((e: any) => e.name === 'sys_session_token')?.value ?? '';
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

let sentinelId = '';

test.beforeAll(async () => {
  await rpc('fulfillment.profile.create', {
    id: PROFILE_ID,
    name: PROFILE_NAME,
    transitions: [{ event: 'go', from: 'DRAFT', to: 'CANCELLED', condition: null, actions: [] }],
  });
  // Watcher pinned to THIS profile via the guard's profileId equality.
  const s = await rpc('nexus.sentinel.create', {
    name: SENTINEL_NAME,
    authorityRole: 'ops.e2e-watcher',
    eventSubscriptions: ['EVENT:FULFILLMENT:TRANSITIONED'],
    reachability: 'polling',
    context: {
      guard: { '==': [{ var: 'event.payload.profileId' }, PROFILE_ID] },
    },
  });
  sentinelId = s.id;
});

test.afterAll(async () => {
  if (sentinelId) await rpc('nexus.sentinel.delete', { id: sentinelId }).catch(() => {});
  await rpc('fulfillment.profile.destroy', { id: PROFILE_ID }).catch(() => {});
});

test('@watchers profile card lists its pinned sentinel with the scope badge', async ({ page }) => {
  await page.goto('/fulfillment');
  await page.waitForLoadState('networkidle');

  // The sentinel name is unique and pinned to OUR profile — so it must appear in
  // exactly ONE card's SENTINELS section (pin semantics: other profiles' cards
  // must NOT list it). Locating by name directly avoids ancestor-div ambiguity.
  const row = page.locator('[data-test="watcher-row"]', { hasText: SENTINEL_NAME });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveCount(1);
  // Pinned scope badge (zh 本 Profile / en this profile). Card placement is already
  // proven by uniqueness: watchersFor() only attaches a pinned sentinel to the card
  // whose id matches the guard's pin, so count===1 ⇒ it is on OUR profile's card.
  await expect(row).toContainText(/本 Profile|this profile/);
});
