import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

test.use({ storageState: path.join(__dirname, '../../state/operator.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

// Unique per run — the spec keeps data (no cleanup), so a per-day-constant name would
// collide on same-redis re-runs (duplicate create → modal stays open).
const PROFILE_NAME = `E2E Profile ${Date.now()}`;
const PROFILE_DESC  = 'Playwright e2e — 创建并保留';
const PROFILE_ID    = `e2e_profile_${Date.now()}`;

// ── helpers ────────────────────────────────────────────────────────────────

function getOperatorToken(): string {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../state/operator.json'), 'utf8')
  );
  return state.origins[0].localStorage.find((e: any) => e.name === 'op_session_token')?.value ?? '';
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getOperatorToken()}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ── tests ──────────────────────────────────────────────────────────────────

test('@fulfillment profile — PROFILE tab is default active', async ({ page }) => {
  await page.goto('/fulfillment');
  await page.waitForLoadState('networkidle');

  // EntityTabs renders tabs from service entities; "profile" tab should be active.
  // The panel title reflects the active entity.
  await expect(page.getByText('FULFILLMENT / PROFILE')).toBeVisible({ timeout: 8_000 });
});

test('@fulfillment profile — create via "+ New" modal, card appears, data kept', async ({ page }) => {
  await page.goto('/fulfillment');
  await page.waitForLoadState('networkidle');

  // Ensure PROFILE tab is active.
  await expect(page.getByText('FULFILLMENT / PROFILE')).toBeVisible({ timeout: 8_000 });

  // Open create modal.
  await page.getByRole('button', { name: /\+ New/i }).click();
  await expect(page.getByText('NEW PROFILE')).toBeVisible();

  // CREATE is disabled while name is empty. (Operator portal labels it en common.create = "Create".)
  const createBtn = page.getByRole('button', { name: /^Create$/i });
  await expect(createBtn).toBeDisabled();

  // Fill name (en placeholder: fulfillment.profile.namePlaceholder = "e.g. Standard fulfillment").
  await page.getByPlaceholder(/Standard fulfillment/i).fill(PROFILE_NAME);
  await expect(createBtn).toBeEnabled();

  // Fill optional description (en: "Describe where this applies...").
  await page.getByPlaceholder(/Describe where this applies/i).fill(PROFILE_DESC);

  // Submit.
  await createBtn.click();

  // Modal closes.
  await expect(page.getByText('NEW PROFILE')).not.toBeVisible({ timeout: 8_000 });

  // Profile card appears in the list.
  await expect(page.getByText(PROFILE_NAME, { exact: true })).toBeVisible({ timeout: 8_000 });
});

test('@fulfillment profile — profile card shows ACTIVE status and Edit/Raw buttons', async ({ page }) => {
  // This test relies on the profile created in the previous test already existing.
  // If running in isolation, ensure at least one profile exists via beforeAll.
  await page.goto('/fulfillment');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('FULFILLMENT / PROFILE')).toBeVisible({ timeout: 8_000 });

  // Skip if no profiles yet (fresh environment).
  const profileCards = page.locator('.service-btn', { hasText: 'Edit' });
  const count = await profileCards.count();
  test.skip(count === 0, 'No profiles to inspect — run create test first');

  // First card: ACTIVE badge, Edit and Raw buttons visible.
  const firstCard = page.locator('div').filter({ hasText: /ACTIVE/ }).first();
  await expect(firstCard).toBeVisible();
  await expect(firstCard.getByRole('button', { name: 'Edit' }).first()).toBeVisible();
  await expect(firstCard.getByRole('button', { name: 'Raw' })).toBeVisible();
});

test('@fulfillment profile — Raw modal shows valid JSON with id field', async ({ page }) => {
  await page.goto('/fulfillment');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('FULFILLMENT / PROFILE')).toBeVisible({ timeout: 8_000 });

  // Ensure there's at least one profile (via API if needed).
  let profileId = '';
  try {
    const { items } = await rpc('fulfillment.profile.list', { page: 1, pageSize: 1 });
    if (items?.length > 0) profileId = items[0].id;
  } catch { /* skip if service offline */ }

  if (!profileId) {
    test.skip(true, 'No profiles available');
    return;
  }

  // Click Raw button on the first card.
  const rawBtn = page.getByRole('button', { name: 'Raw' }).first();
  await rawBtn.click();

  // Raw modal opens with a <pre> containing parseable JSON. Assert the <pre> directly —
  // getByText('Raw') is ambiguous (matches both the Raw button and the modal title).
  await expect(page.locator('pre')).toBeVisible({ timeout: 5_000 });
  const rawText = await page.locator('pre').innerText();
  const parsed = JSON.parse(rawText);
  expect(parsed.id).toBeTruthy();

  // Close.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('pre')).not.toBeVisible();
});

// NOTE: No afterAll cleanup — data is intentionally kept (保留数据).
