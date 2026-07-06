import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

/**
 * EVENT BUS page regression:
 *   - lands on RUNS (not the dev-empty SCHEDULES) and the status filter knows
 *     FAILED / STALLED (both real orchestrator statuses that used to be absent);
 *   - STREAM LOG actually reads the bus: drive a real fulfillment transition via
 *     RPC (emits EVENT:FULFILLMENT:TRANSITIONED through the relay) and assert the
 *     stream + entry render. FAILED-row inline reasons are covered opportunistically
 *     when failed runs exist (deterministic FAILED creation needs a seeded workflow).
 */

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';
const TS = Date.now();
const PROFILE_ID = `e2e_ebus_${TS}`;

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

test.afterAll(async () => {
  await rpc('fulfillment.profile.destroy', { id: PROFILE_ID }).catch(() => {});
});

test('@eventbus lands on RUNS and the filter knows FAILED / STALLED', async ({ page }) => {
  await page.goto('/events');
  await page.waitForLoadState('networkidle');

  // Default tab is RUNS — its status filter is on screen. Anchor on the
  // ALL STATUSES option (a bare `select` would match the layout's language picker).
  const filter = page.locator('select').filter({ hasText: 'ALL STATUSES' });
  await expect(filter).toBeVisible({ timeout: 10_000 });
  const options = await filter.locator('option').allTextContents();
  expect(options).toContain('FAILED');
  expect(options).toContain('STALLED');

  // Opportunistic: when FAILED runs exist (dev heartbeats), each row must carry
  // its inline reason instead of hiding it behind RAW.
  await filter.selectOption('FAILED');
  await page.waitForLoadState('networkidle');
  const rows = page.locator('div.grid', { hasText: 'RAW' });
  const n = await rows.count();
  if (n > 0) {
    await expect(page.locator('[data-test="run-error"]').first()).toBeVisible({ timeout: 10_000 });
  }
});

test('@eventbus STREAM LOG renders real bus traffic from a fulfillment transition', async ({ page }) => {
  // Drive the bus: profile + instance + one engine transition → TRANSITIONED event.
  await rpc('fulfillment.profile.create', {
    id: PROFILE_ID,
    name: `E2E EventBus ${TS}`,
    transitions: [{ event: 'go', from: 'DRAFT', to: 'CANCELLED', condition: null, actions: [] }],
  });
  const inst = await rpc('fulfillment.instance.create', {
    sourceId: `SO-EBUS-${TS}`, profileId: PROFILE_ID, meta: {},
  });
  await rpc('fulfillment.instance.transition', { id: inst.id, event: 'go' });

  await page.goto('/events');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'STREAM LOG' }).click();

  // The stream appears in the selector (most-recently-active first); pick it.
  const select = page.locator('[data-test="stream-select"]');
  await expect(select).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => {
      await page.locator('[data-test="stream-refresh"]').click();
      return (await select.locator('option').allTextContents()).join('|');
    }, { timeout: 20_000 })
    .toContain('EVENT:FULFILLMENT:TRANSITIONED');
  await select.selectOption({ index: (await select.locator('option').allTextContents())
    .findIndex(t => t.includes('EVENT:FULFILLMENT:TRANSITIONED')) });

  // Entries render newest-first with the lifted type field.
  await expect(page.locator('[data-test="stream-entry"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-test="stream-entries"]')).toContainText('instance.transitioned');
});
