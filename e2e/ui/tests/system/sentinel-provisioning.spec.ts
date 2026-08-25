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
  // 用卡片自己的稳定钩子上溯,别再写 `xpath=..`——UID 那个 <span title> 外面套了
  // 几层纯样式 div,上跳一层根本够不到 token 单元格(报 "element(s) not found",
  // 看起来像徽章没渲染,其实是选择器假设的层级早变了)。同 bot-accounts.spec.ts。
  const botRow = page.locator(`[data-test="bot-card"]:has([title="${BOT_UID}"])`);
  await expect(botRow.locator('[data-test="bot-token-state"]')).toContainText('SENTINEL', { timeout: 10_000 });
  await expect(botRow.locator('[data-test="bot-token-state"]')).toContainText('●');
});

test('@provisioning /nexus shows BOT ● badge and PERMIT exposes the empty-permit gap', async ({ page }) => {
  await page.goto('/nexus/sentinels');
  await page.waitForLoadState('networkidle');

  // NexusManagement 的 sentinel 卡片没有行级 data-test,用「最近的、含 identity-badge
  // 的祖先 div」定位——与具体嵌套层数解耦,改版式不会再把这条断言打成"徽章不存在"。
  const row = page.locator(`[title="${BOT_UID}"]`)
    .locator('xpath=ancestor::div[.//*[@data-test="identity-badge"]][1]');
  await expect(row.locator('[data-test="identity-badge"]')).toContainText('BOT', { timeout: 10_000 });
  await expect(row.locator('[data-test="identity-badge"]')).toContainText('●');

  // PERMIT modal: the declared fetcher is NOT granted (banner-created bot = empty permit).
  // 动作已经收进每张卡片的「⋯」下拉菜单(NexusManagement 的 Actions Dropdown,
  // `openMenuId === sentinel.id` 时才渲染),所以必须先开菜单再点 PERMIT。
  // 卡片用 data-test="sentinel-name" 上溯定位,不要用 `div.grid` 这种绑死样式类的选择器
  // ——它只要 Tailwind 类一动就失配,而报出来的是"找不到 PERMIT 按钮"。
  // 列表里 sentinel 名字挂在 `title={sentinel.name}` 的 span 上
  // (`data-test="sentinel-name"` 是**表单里的 input**,不是列表项——别搞混)。
  const sentinelCard = page.locator(`[title="${SENTINEL_NAME}"]`)
    .locator('xpath=ancestor::div[.//button[@data-test="sentinel-menu"]][1]');
  await sentinelCard.locator('[data-test="sentinel-menu"]').click();
  await page.getByRole('button', { name: /PERMIT/i }).first().click();
  const modal = page.locator('[data-test="sentinel-permit-modal"]');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(BOT_UID);
  await expect(modal).toContainText(/token injected/i);   // en nexus_mgmt.token_injected; sibling :64 injects it
  const need = modal.locator('[data-test="permit-need-row"]', { hasText: 'collection.payment.get' });
  await expect(need).toContainText('✗ missing');
});
