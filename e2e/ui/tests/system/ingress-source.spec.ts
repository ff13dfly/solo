import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

// Names must match ^[a-zA-Z0-9_-]{1,64}$
const CREATE_NAME = `e2e-src-${Date.now()}`;
const DELETE_NAME = `e2e-del-${Date.now()}`;

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

// ── setup / teardown ───────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Pre-create the source that the delete test will exercise via UI.
  await rpc('ingress.source.create', { name: DELETE_NAME, dedupTtlSec: 86400 });
});

test.afterAll(async () => {
  // Best-effort cleanup for any test sources left behind.
  try {
    const { items } = await rpc('ingress.source.list', { page: 1, pageSize: 100 });
    for (const s of items) {
      if (s.name === CREATE_NAME || s.name === DELETE_NAME) {
        await rpc('ingress.source.delete', { id: s.id }).catch(() => {});
        console.log(`[cleanup] deleted test source "${s.name}"`);
      }
    }
  } catch (err) {
    console.warn('[cleanup] ingress source cleanup failed:', err);
  }
});

// ── tests ──────────────────────────────────────────────────────────────────

test('@ingress create source — form, api-key reveal, appears in list', async ({ page }) => {
  await page.goto('/ingress');
  await page.waitForLoadState('networkidle');

  // SOURCES tab should be active by default.
  await expect(page.getByRole('button', { name: /NEW SOURCE/i })).toBeVisible();

  // Open create modal.
  await page.getByRole('button', { name: /NEW SOURCE/i }).click();
  await expect(page.getByText('NEW INBOUND SOURCE')).toBeVisible();

  // CREATE is disabled while name is empty.
  const createBtn = page.getByRole('button', { name: /^CREATE$/ });
  await expect(createBtn).toBeDisabled();

  // Fill name — must match ^[a-zA-Z0-9_-]{1,64}$.
  await page.getByPlaceholder('e.g. github').fill(CREATE_NAME);
  await expect(createBtn).toBeEnabled();

  // Submit.
  await createBtn.click();

  // One-time API key reveal modal must appear.
  await expect(page.getByText(`API KEY CREATED: ${CREATE_NAME}`)).toBeVisible({ timeout: 8_000 });

  // The key is shown inside a <code> element with format ingk_<48 hex chars>.
  const keyEl = page.locator('code').filter({ hasText: /ingk_[a-f0-9]+/i });
  await expect(keyEl).toBeVisible();
  const apiKey = (await keyEl.innerText()).trim();
  expect(apiKey).toMatch(/^ingk_[a-f0-9]{48}$/);

  // Dismiss the reveal modal.
  await page.getByRole('button', { name: /^DONE$/ }).click();
  await expect(page.getByText(`API KEY CREATED: ${CREATE_NAME}`)).not.toBeVisible();

  // New source row appears in the list.
  await expect(page.getByText(CREATE_NAME, { exact: true })).toBeVisible({ timeout: 5_000 });
});

test('@ingress delete source — confirm dialog, row removed from list', async ({ page }) => {
  await page.goto('/ingress');
  await page.waitForLoadState('networkidle');

  // Verify the pre-created source is in the list.
  await expect(page.getByText(DELETE_NAME, { exact: true })).toBeVisible();

  // Click DEL on the correct row: find the name cell by its `title` attribute,
  // go up one level to the grid row, then find the DEL button within that row.
  await page.locator(`[title="${DELETE_NAME}"]`).locator('xpath=..').getByRole('button', { name: 'DEL' }).click();

  // Confirm modal appears — title must reference the source name.
  await expect(page.getByText(new RegExp(`Delete source.*${DELETE_NAME}`))).toBeVisible();

  // Click the dangerous DELETE button to confirm.
  await page.getByRole('button', { name: /^DELETE$/ }).click();

  // Success toast.
  await expect(page.getByText(`Source "${DELETE_NAME}" deleted`)).toBeVisible({ timeout: 8_000 });

  // Row is gone from the list.
  await expect(page.getByText(DELETE_NAME, { exact: true })).not.toBeVisible({ timeout: 5_000 });
});
