import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

// System portal admin session (created by global-setup.ts).
test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

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

// Two PENDING_REVIEW workflows: one HIGH-risk (write step) and one LOW-risk (read).
const HIGH_ID = `e2e-ui-high-${Date.now()}`;
const LOW_ID  = `e2e-ui-low-${Date.now()}`;

test.beforeAll(async () => {
  await rpc('orchestrator.workflow.create', {
    id: HIGH_ID, category: { name: 'e2e-ui' }, name: 'UI HIGH-risk wf', desc: 'writes → multi-sig',
    steps: [{ id: 's1', service: 'gateway', method: 'gateway.email.send', params: { to: 'x@y.z' } }],
    event_subscriptions: [{ stream: 'EVENT:E2E:UI', filter: { type: 'ui.test' } }],
  }).catch(() => {});
  await rpc('orchestrator.workflow.create', {
    id: LOW_ID, category: { name: 'e2e-ui' }, name: 'UI LOW-risk wf', desc: 'reads → fast lane',
    steps: [{ id: 's1', service: 'collection', method: 'collection.payment.get', params: { id: 'x' } }],
  }).catch(() => {});
});

test.afterAll(async () => {
  for (const id of [HIGH_ID, LOW_ID]) await rpc('orchestrator.workflow.delete', { id }).catch(() => {});
});

test('@approval signing-key modal — open, generate, status updates', async ({ page }) => {
  await page.goto('/workflows');
  await page.waitForLoadState('networkidle');

  await page.locator('[data-test="open-signing-key"]').click();
  const modal = page.locator('[data-test="signing-key-modal"]');
  await expect(modal).toBeVisible();

  // generate (or re-provision) a key with a password
  await modal.locator('input[type="password"]').fill('e2e-ui-signing-pass');
  await modal.locator('[data-test="key-generate"]').click();

  // status flips to "have key" (success path)
  await expect(modal.locator('[data-test="key-status"]')).toContainText(/active signing key|可用的签名密钥/, { timeout: 10000 });
});

test('@approval HIGH-risk review — shows footprint/subscriptions/schema + risk, reveals password', async ({ page }) => {
  await page.goto('/workflows');
  await page.waitForLoadState('networkidle');

  await page.locator(`[data-test="approve-${HIGH_ID}"]`).click();
  const modal = page.locator('[data-test="approval-review-modal"]');
  await expect(modal).toBeVisible();

  // the anti-blind-signing surface: every section is shown before signing
  await expect(modal.locator('[data-test="risk-badge"]')).toContainText(/HIGH/);
  await expect(modal.locator('[data-test="footprint-section"]')).toContainText('gateway.email.send');
  await expect(modal.locator('[data-test="subscriptions-section"]')).toContainText('EVENT:E2E:UI');
  await expect(modal.locator('[data-test="input-schema-section"]')).toBeVisible();

  // HIGH-risk → the sign affordance reveals a password field
  await modal.locator('[data-test="approve-high"]').click();
  await expect(modal.locator('[data-test="password-section"]')).toBeVisible();
  await expect(modal.locator('input[type="password"]')).toBeVisible();
});

test('@approval LOW-risk review — shows LOW badge + one-click approve affordance', async ({ page }) => {
  await page.goto('/workflows');
  await page.waitForLoadState('networkidle');

  await page.locator(`[data-test="approve-${LOW_ID}"]`).click();
  const modal = page.locator('[data-test="approval-review-modal"]');
  await expect(modal).toBeVisible();

  await expect(modal.locator('[data-test="risk-badge"]')).toContainText(/LOW/);
  await expect(modal.locator('[data-test="approve-low"]')).toBeVisible();
  // no password section in the fast lane
  await expect(modal.locator('[data-test="password-section"]')).toHaveCount(0);
});
