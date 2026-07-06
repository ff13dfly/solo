import { test, expect } from '../../helpers/fixtures';
import { recordRpc } from '../../helpers/rpc';
import path from 'path';

/**
 * RPC-surface assertions (septopus `serverHits` pattern) — verify WHAT the portal calls,
 * not just that pages render. Two complementary guarantees:
 *
 *  1. Anonymous surface: an unauthenticated visitor's UI must never emit a privileged or
 *     non-public method. This is the UI-layer mirror of the passport public-method
 *     convergence work — `storage.asset.multi` was narrowed to auth-required, so no
 *     pre-login screen should ever call it (or any admin method).
 *  2. Authenticated surface: once logged in, EVERY RPC the portal sends carries a Bearer
 *     token — the portal never leaks an unauthenticated privileged call.
 */

// Privileged / non-public methods an unauthenticated UI must never emit.
// storage.asset.multi was flipped public:true→false in the convergence work.
const PRIVILEGED = [
  'storage.asset.multi',
  'user.account.list',
  'user.bot.list',
  'system.service.add',
  'orchestrator.workflow.list',
];

test.describe('@rpc anonymous surface emits no privileged RPC', () => {
  test.use({ storageState: { cookies: [], origins: [] } });   // no admin session

  test('pre-login UI never calls a privileged/non-public method', async ({ page }) => {
    const rec = recordRpc(page);
    await page.goto('/');
    // No session → RequireAuth bounces to /login.
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    rec.assertNoneSent(PRIVILEGED);
  });
});

test.describe('@rpc authenticated surface always carries auth', () => {
  test.use({ storageState: path.join(__dirname, '../../state/system.json') });

  test('every RPC the dashboard emits carries a Bearer token', async ({ page }) => {
    const rec = recordRpc(page);
    await page.goto('/services');
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState('networkidle');

    // The page actually talked to the Router (otherwise the check below is vacuous).
    expect(rec.calls.length, 'the services page should make at least one RPC').toBeGreaterThan(0);

    const unauthed = rec.calls.filter((c) => !c.hadAuth).map((c) => c.method);
    expect(unauthed, `these RPCs left WITHOUT a Bearer token: ${unauthed.join(', ')}`).toEqual([]);
  });
});
