import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';
// Unique name so parallel or repeated runs don't collide.
const SENTINEL_NAME = `E2E Sentinel ${Date.now()}`;
const SENTINEL_ROLE = 'system.*';

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

// ── cleanup ────────────────────────────────────────────────────────────────

test.afterAll(async () => {
  try {
    const { items } = await rpc('nexus.sentinel.list', { page: 1, pageSize: 100 });
    for (const s of items) {
      if (s.name === SENTINEL_NAME) {
        await rpc('nexus.sentinel.delete', { id: s.id });
        console.log(`[cleanup] deleted test sentinel ${s.id}`);
      }
    }
  } catch (err) {
    console.warn('[cleanup] could not delete test sentinel:', err);
  }
});

// ── tests ──────────────────────────────────────────────────────────────────

test('@nexus create sentinel — form validates required fields', async ({ page }) => {
  await page.goto('/nexus/sentinels');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: /NEW SENTINEL/i }).click();
  await expect(page.getByText('REGISTER SENTINEL')).toBeVisible();

  // CREATE button is disabled while required fields are empty.
  const createBtn = page.getByRole('button', { name: /^CREATE$/ });
  await expect(createBtn).toBeDisabled();

  // Filling only name still keeps it disabled (authority role missing).
  await page.getByPlaceholder('e.g. Security Auditor').fill(SENTINEL_NAME);
  await expect(createBtn).toBeDisabled();

  // Filling authority role enables it.
  await page.getByPlaceholder('e.g. security_auditor').fill(SENTINEL_ROLE);
  await expect(createBtn).toBeEnabled();

  // Cancel without saving.
  await page.getByRole('button', { name: /CANCEL/i }).click();
  await expect(page.getByText('REGISTER SENTINEL')).not.toBeVisible();
});

test('@nexus create sentinel — saves and appears in list', async ({ page }) => {
  await page.goto('/nexus/sentinels');
  await page.waitForLoadState('networkidle');

  // Open modal
  await page.getByRole('button', { name: /NEW SENTINEL/i }).click();
  await expect(page.getByText('REGISTER SENTINEL')).toBeVisible();

  // Fill required fields
  await page.getByPlaceholder('e.g. Security Auditor').fill(SENTINEL_NAME);
  await page.getByPlaceholder('e.g. security_auditor').fill(SENTINEL_ROLE);

  // Submit
  await page.getByRole('button', { name: /^CREATE$/ }).click();

  // Success toast appears
  await expect(page.getByText(`Sentinel "${SENTINEL_NAME}" created`)).toBeVisible({ timeout: 8_000 });

  // Modal closes
  await expect(page.getByText('REGISTER SENTINEL')).not.toBeVisible();

  // New row appears in the sentinel list (exact: true excludes the toast which wraps the name in quotes)
  await expect(page.getByText(SENTINEL_NAME, { exact: true })).toBeVisible({ timeout: 5_000 });
});
