import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

// Bots used across tests. system.planner is pre-created in beforeAll so each
// test is independent. system.storage is created via UI in the create test.
const PLANNER_BOT = 'system.planner';
const STORAGE_BOT = 'system.storage';
const NOTIF_BOT   = 'system.notification'; // pre-exists; notification.token.set is live

// ── helpers ────────────────────────────────────────────────────────────────

function getAdminToken(): string {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../state/system.json'), 'utf8')
  );
  return state.origins[0].localStorage.find((e: any) => e.name === 'sys_session_token')?.value ?? '';
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// Locate the action buttons in the card that owns a given bot UID.
//
// 用行卡片自己的稳定钩子 `data-test="bot-card"` 上溯,不要再写 `xpath=..`:UID 那个
// <span title={bot.id}> 外面套了几层纯样式 div(状态点 + uid 在同一个 flex 里),上跳
// 一层落在的容器里**没有任何按钮**,于是每个用例都卡到 30s 超时,报的却是
// "locator.click: Test timeout" —— 看起来像页面没加载或按钮没渲染,与真因(选择器
// 假设了一个早就变了的 DOM 层级)毫无关联感。层级是样式产物、随时会变;
// data-test 才是契约(README §Page objects: "Key elements carry a stable data-testid")。
// 动作按钮住在**点选后才展开的抽屉**里:未选中时是
// `max-h-0 opacity-0 pointer-events-none`(见 portal/system/src/pages/bots/index.tsx
// 的 "Action Drawer (Expandable)")。UI 从「扁平行、按钮常驻」演进成了「卡片点选展开」,
// 而 spec 还在直接点按钮 ⇒ 元素找得到却永远不 visible,报的是
// "waiting for element to be visible, enabled and stable" 直到 30s 超时。
// 所以这里先确保卡片被选中,再交出按钮。
async function botRowBtn(page: any, uid: string, label: string) {
  const card = page.locator(`[data-test="bot-card"]:has([title="${uid}"])`);
  await card.waitFor({ state: 'visible' });
  // 判据用卡片的 `selected` 类,**不要用 btn.isVisible()**:抽屉收起时是
  // `max-h-0 + overflow-hidden`,被裁掉的子元素**仍然有布局盒子**,于是
  // Playwright 的 isVisible() 照样返回 true —— 「不可见才展开」这种写法永远不触发。
  // 随后点击落在被裁剪的按钮上,命中测试返回的是卡片,报
  // "<div data-test=bot-card> intercepts pointer events" 一路重试到 30s 超时。
  const selected = await card.evaluate((el: Element) => el.classList.contains('selected'));
  if (!selected) {
    await card.click();                                  // 展开动作抽屉
    await card.locator('.selected, :scope.selected').first().waitFor({ state: 'attached' }).catch(() => {});
    await page.waitForTimeout(400);                      // max-height transition 是 300ms
  }
  const btn = card.getByRole('button', { name: label });
  await btn.scrollIntoViewIfNeeded();
  return btn;
}

// ── setup / teardown ───────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Reset: delete test bots if they exist from a previous run.
  for (const uid of [PLANNER_BOT, STORAGE_BOT]) {
    await rpc('user.bot.delete', { uid }).catch(() => {});
  }
  // Pre-create system.planner for the permit / inject / revoke tests.
  await rpc('user.bot.create', {
    uid: PLANNER_BOT,
    desc: 'e2e test bot',
    permit: { allow_all: false, services: {} },
  });
});

test.afterAll(async () => {
  for (const uid of [PLANNER_BOT, STORAGE_BOT]) {
    await rpc('user.bot.delete', { uid }).catch(() => {});
  }
});

// ── tests ──────────────────────────────────────────────────────────────────

test('@bot create — select service, confirm, appears in list', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  // Open create modal.
  await page.getByRole('button', { name: /NEW BOT/i }).click();
  await expect(page.getByText('CREATE BOT ACCOUNT')).toBeVisible();

  // CREATE is disabled until a service is selected. Scope to the modal — the
  // sentinel-provisioning banner also renders CREATE buttons (strict-mode clash).
  const createBtn = page.getByRole('button', { name: /^CREATE$/ }).last();
  await expect(createBtn).toBeDisabled();

  // Choose 'storage' from the service dropdown (scope by its default option text).
  await page.locator('select').filter({ hasText: '— select a service —' }).selectOption('storage');
  await expect(createBtn).toBeEnabled();

  // Add an optional description.
  await page.getByPlaceholder('What this bot is used for').fill('e2e storage bot');

  // Submit.
  await createBtn.click();
  await expect(page.getByText(`Bot "${STORAGE_BOT}" created`)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('CREATE BOT ACCOUNT')).not.toBeVisible();

  // Row appears in the list.
  await expect(page.locator(`[title="${STORAGE_BOT}"]`)).toBeVisible({ timeout: 5_000 });
});

test('@bot raw view — modal opens with valid JSON, closes', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  await (await botRowBtn(page, PLANNER_BOT, 'RAW')).click();
  await expect(page.getByText(new RegExp(`RAW BOT DATA:.*${PLANNER_BOT}`))).toBeVisible();

  // The <pre> block must contain parseable JSON with the correct uid.
  const rawText = await page.locator('pre').innerText();
  const parsed = JSON.parse(rawText);
  expect(parsed.id).toBe(PLANNER_BOT);

  await page.getByRole('button', { name: /^CLOSE$/ }).click();
  await expect(page.getByText(new RegExp(`RAW BOT DATA:`))).not.toBeVisible();
});

test('@bot permit — add service permission, save, toast success', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  await (await botRowBtn(page, PLANNER_BOT, 'PERMIT')).click();
  await expect(page.getByText(`Edit Bot Permit: ${PLANNER_BOT}`)).toBeVisible();

  // Add 'agent' service via the "+ ADD SERVICE" dropdown.
  // ('user' and 'administrator' are in PERMIT_CONFIG.restrictedServices and never shown.)
  await page.locator('select').filter({ hasText: '+ ADD SERVICE' }).selectOption('agent');

  // The agent service block should now appear.
  await expect(page.getByText('agent', { exact: true }).first()).toBeVisible();

  // Save.
  await page.getByRole('button', { name: /SAVE CHANGES/i }).click();
  await expect(page.getByText('Permissions saved successfully')).toBeVisible({ timeout: 8_000 });
});

test('@bot inject success — notification.token.set lives, toast confirms deploy', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  await (await botRowBtn(page, NOTIF_BOT, 'INJECT')).click();

  // Either "Token issued and injected into notification" (success)
  // or a fallback IssueTokenModal (service temporarily unreachable).
  const successToast = page.getByText(/Token issued and injected into notification/i);
  const fallbackModal = page.getByText(/TOKEN ISSUED:/i);

  await expect(successToast.or(fallbackModal)).toBeVisible({ timeout: 10_000 });

  // If fallback modal appeared, acknowledge and close cleanly.
  if (await fallbackModal.isVisible()) {
    await page.locator('input[type="checkbox"]').last().check();
    await page.getByRole('button', { name: /^CLOSE$/ }).click();
    await expect(fallbackModal).not.toBeVisible();
  }
});

test('@bot non-relay bot offers ISSUE TOKEN (manual) → IssueTokenModal appears', async ({ page }) => {
  // planner is not a relay service and no sentinel declares system.planner, so it
  // gets ISSUE TOKEN (manual one-time token), NOT INJECT. (INJECT used to appear for
  // every system.* uid and fired a nonexistent planner.token.set — that's now fixed.)
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  await (await botRowBtn(page, PLANNER_BOT, 'ISSUE TOKEN')).click();

  // ISSUE TOKEN confirms first (unlike INJECT) — accept it.
  await page.getByRole('button', { name: /^CONFIRM$/ }).click();

  // One-time token modal.
  await expect(page.getByText(`TOKEN ISSUED: ${PLANNER_BOT}`)).toBeVisible({ timeout: 10_000 });

  // Token is shown in a textarea and must be non-empty.
  const tokenText = await page.locator('textarea[readonly]').inputValue();
  expect(tokenText.length).toBeGreaterThan(20);

  // CLOSE is disabled until the acknowledgment checkbox is checked.
  const closeBtn = page.getByRole('button', { name: /^CLOSE$/ });
  await expect(closeBtn).toBeDisabled();

  await page.getByRole('checkbox', { name: /I have copied the token/ }).check();
  await expect(closeBtn).toBeEnabled();
  await closeBtn.click();

  await expect(page.getByText(`TOKEN ISSUED: ${PLANNER_BOT}`)).not.toBeVisible();
});

test('@bot revoke — confirm dialog, all tokens revoked, bot remains', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  await (await botRowBtn(page, PLANNER_BOT, 'REVOKE')).click();

  // Confirm dialog body is unique to the modal (not the list row title). Portal default
  // lang is en → assert the en confirm body (bot_mgmt.revokeConfirm).
  await expect(page.getByText(/Revoke ALL live session tokens/i)).toBeVisible();
  await page.getByRole('button', { name: /^CONFIRM$/ }).click();

  // Toast confirms revocation (en bot_mgmt.revokedCount = "Revoked {n} token(s)").
  await expect(page.getByText(/Revoked \d+ token/i)).toBeVisible({ timeout: 8_000 });

  // Bot row is still there — REVOKE does NOT delete the account.
  await expect(page.locator(`[title="${PLANNER_BOT}"]`)).toBeVisible();
});

test('@bot delete — confirm dialog, row removed from list', async ({ page }) => {
  await page.goto('/bots');
  await page.waitForLoadState('networkidle');

  // Verify the bot is present before deleting.
  await expect(page.locator(`[title="${PLANNER_BOT}"]`)).toBeVisible();

  await (await botRowBtn(page, PLANNER_BOT, 'DELETE')).click();

  // Confirm dialog is dangerous (red CONFIRM button).
  await expect(page.getByText(/Permanently delete bot/)).toBeVisible();
  await page.getByRole('button', { name: /^CONFIRM$/ }).click();

  await expect(page.getByText(`Bot "${PLANNER_BOT}" deleted`)).toBeVisible({ timeout: 8_000 });

  // Row is gone.
  await expect(page.locator(`[title="${PLANNER_BOT}"]`)).not.toBeVisible({ timeout: 5_000 });
});
