import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

/**
 * The autorun + emit context editor (BACKLOG §2.7): an AI-driven sentinel can now be
 * configured entirely from /nexus — no RPC. Create one through the form, assert the
 * structured autorun + emit persisted, reopen EDIT and assert the values round-trip.
 */

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';
const TS = Date.now();
const NAME = `E2E Autorun Sentinel ${TS}`;

function getAdminToken(): string {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '../../state/system.json'), 'utf8'));
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

let createdId = '';
test.afterAll(async () => {
  if (createdId) { await rpc('nexus.sentinel.delete', { id: createdId }).catch(() => {}); return; }
  const { items } = await rpc('nexus.sentinel.list', { page: 1, pageSize: 200 }).catch(() => ({ items: [] }));
  for (const s of (items || [])) if (s.name === NAME) await rpc('nexus.sentinel.delete', { id: s.id }).catch(() => {});
});

test('@autorun create AI sentinel via form → autorun + emit persist, EDIT round-trips', async ({ page }) => {
  await page.goto('/nexus/sentinels');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: /NEW SENTINEL/i }).click();
  await page.locator('[data-test="sentinel-name"]').fill(NAME);
  await page.locator('[data-test="sentinel-role"]').fill('ops.e2e-autorun');
  await page.locator('[data-test="sentinel-subscriptions"]').fill('EVENT:E2E:AUTORUN');

  // 表单已经分成三个标签页(Basic Info / Context & Prompt / AI & Action),
  // 每个 tab 的内容是**条件渲染**的(`formActiveTab === '...'`),不切过去元素根本不在 DOM 里。
  // 此前 spec 当它是一张平铺的表,填完 basic 就直接 check ctx-enable ⇒
  // "waiting for locator([data-test=ctx-enable])" 一路等到 30s 超时。
  const formTab = (name: RegExp) => page.getByRole('button', { name });

  // Enable context, then autorun (choices + threshold) and emit (stream + type + payload).
  await formTab(/Context & Prompt/i).click();
  await page.locator('[data-test="ctx-enable"]').check();

  await formTab(/AI & Action/i).click();
  const autorun = page.locator('[data-test="ctx-autorun"]');
  await autorun.locator('input[type="checkbox"]').check();
  await autorun.getByPlaceholder('approve, hold').fill('approve, hold');
  await autorun.getByPlaceholder('0.7').fill('0.7');

  const emit = page.locator('[data-test="ctx-emit"]');
  await emit.locator('input[type="checkbox"]').check();
  await emit.getByPlaceholder('EVENT:SENTINEL:RISK-REVIEW').fill('EVENT:SENTINEL:E2E');
  await emit.getByPlaceholder('sentinel.risk.assessed').fill('e2e.decided');
  await emit.locator('textarea').last().fill('{ "decision": "{{output.decision}}" }');

  await page.getByRole('button', { name: /^CREATE$/ }).click();
  await expect(page.getByText(`Sentinel "${NAME}" created`)).toBeVisible({ timeout: 10_000 });

  // Persisted shape (the contract the form must hit).
  const { items } = await rpc('nexus.sentinel.list', { page: 1, pageSize: 200 });
  const created = (items || []).find((s: any) => s.name === NAME);
  expect(created).toBeTruthy();
  createdId = created.id;
  expect(created.context.autorun).toEqual({ choices: ['approve', 'hold'], confidence_threshold: 0.7 });
  expect(created.context.emit).toMatchObject({
    stream: 'EVENT:SENTINEL:E2E',
    type: 'e2e.decided',
    payload_template: { decision: '{{output.decision}}' },
  });

  // EDIT round-trip: reopen and confirm the editor re-loaded the values (no silent loss).
  // 动作收进了每张卡片的「⋯」菜单;`div.grid` 那种绑死样式类的选择器也一并换掉。
  const card = page.locator(`[title="${NAME}"]`)
    .locator('xpath=ancestor::div[.//button[@data-test="sentinel-menu"]][1]');
  await card.locator('[data-test="sentinel-menu"]').click();
  // 菜单项文本带 emoji 前缀(`✏️ EDIT`),`/^EDIT$/` 这种锚定写法匹配不上。
  await page.getByRole('button', { name: /EDIT/i }).first().click();
  await formTab(/AI & Action/i).click();
  await expect(page.locator('[data-test="ctx-autorun"]').getByPlaceholder('approve, hold')).toHaveValue('approve, hold');
  await expect(page.locator('[data-test="ctx-autorun"]').getByPlaceholder('0.7')).toHaveValue('0.7');
  await expect(page.locator('[data-test="ctx-emit"]').getByPlaceholder('EVENT:SENTINEL:RISK-REVIEW')).toHaveValue('EVENT:SENTINEL:E2E');
});
