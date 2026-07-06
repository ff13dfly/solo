import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

/**
 * §1.2 sentinel provisioning journey across BOT ACCOUNTS + NEXUS:
 *   sentinel declares a system.* identity (no bot, no token)
 *     → /bots banner: 缺 bot 账号 [CREATE] → token 未注入 [INJECT] → banner clears
 *     → bot row TOKEN column flips to ● SENTINEL
 *     → /nexus identity badge shows BOT ●
 *     → PERMIT modal: declared fetcher shows ✗ missing (banner-created bot has an
 *       EMPTY permit — the needs-vs-grants table must expose exactly that gap).
 */

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';
const TS = Date.now();
const BOT_UID = `system.e2eprov${TS}`;
const SENTINEL_NAME = `E2E Provisioning Sentinel ${TS}`;

function getAdminToken(): string {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../state/system.json'), 'utf8')
  );
  return state.origins[0].localStorage.find((e: any) => e.name === 'sys_session_token')?.value ?? '';
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAdminToken()}` },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

let sentinelId = '';

test.beforeAll(async () => {
  // A sentinel that DECLARES its own identity + a fetcher need, with neither the
  // bot account nor the token provisioned (pre-audit deliberately skips when no
  // token exists yet — runtime would abort, which is exactly the worklist case).
  const s = await rpc('nexus.sentinel.create', {
    name: SENTINEL_NAME,
    authorityRole: BOT_UID,
    eventSubscriptions: ['EVENT:WORKFLOW:STATUS'],
    reachability: 'polling',
    context: {
      data_fetchers: [{ key: 'p', method: 'collection.payment.get', params: { id: 'none' } }],
    },
  });
  sentinelId = s.id;
});

test.afterAll(async () => {
  if (sentinelId) await rpc('nexus.sentinel.delete', { id: sentinelId }).catch(() => {});
  await rpc('user.token.revoke', { uid: BOT_UID }).catch(() => {});
  await rpc('user.bot.delete', { uid: BOT_UID }).catch(() => {});
});

test('@provisioning banner CREATE → INJECT → TOKEN column arms, banner clears', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  // Worklist banner names this sentinel as missing its bot account.
  const banner = page.locator('[data-test="sentinel-coverage-banner"]');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  const row = banner.locator('[data-test="provisioning-row"]', { hasText: SENTINEL_NAME });
  await expect(row).toContainText('缺 bot 账号');

  // CREATE — bot account appears, the row flips to the missing-token stage.
  await row.getByRole('button', { name: 'CREATE' }).click();
  await expect(row).toContainText('token 未注入', { timeout: 10_000 });

  // INJECT — token issued + injected via nexus.sentinel.token.set.
  await row.getByRole('button', { name: 'INJECT' }).click();
  await expect(
    banner.locator('[data-test="provisioning-row"]', { hasText: SENTINEL_NAME })
  ).toHaveCount(0, { timeout: 10_000 });

  // The bot row's TOKEN column now shows the armed sentinel identity.
  const botRow = page.locator(`[title="${BOT_UID}"]`).locator('xpath=..');
  await expect(botRow.locator('[data-test="bot-token-state"]')).toContainText('SENTINEL', { timeout: 10_000 });
  await expect(botRow.locator('[data-test="bot-token-state"]')).toContainText('●');
});

test('@provisioning /nexus shows BOT ● badge and PERMIT exposes the empty-permit gap', async ({ page }) => {
  await page.goto('/nexus/sentinels');
  await page.waitForLoadState('networkidle');

  const row = page.locator(`[title="${BOT_UID}"]`).locator('xpath=..');
  await expect(row.locator('[data-test="identity-badge"]')).toContainText('BOT', { timeout: 10_000 });
  await expect(row.locator('[data-test="identity-badge"]')).toContainText('●');

  // PERMIT modal: the declared fetcher is NOT granted (banner-created bot = empty permit).
  const sentinelRow = page.locator('div.grid', { hasText: SENTINEL_NAME }).first();
  await sentinelRow.getByRole('button', { name: 'PERMIT' }).click();
  const modal = page.locator('[data-test="sentinel-permit-modal"]');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(BOT_UID);
  await expect(modal).toContainText(/token injected/i);   // en nexus_mgmt.token_injected; sibling :64 injects it
  const need = modal.locator('[data-test="permit-need-row"]', { hasText: 'collection.payment.get' });
  await expect(need).toContainText('✗ missing');
});
