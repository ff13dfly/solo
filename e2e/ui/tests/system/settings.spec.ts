import { test, expect } from '../../helpers/fixtures';
import path from 'path';
import fs from 'fs';

test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

// ── direct-RPC helper (admin token from the saved portal state) ──────────────
// Settings 的"参数部分"全部走 router 方法（setting.* / system.service.list），
// 这些方法久未变动；用直连 RPC 做 round-trip 校验，UI 只负责触发与渲染。

function getAdminToken(): string {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../state/system.json'), 'utf8')
  );
  return state.origins[0].localStorage.find((e: any) => e.name === 'sys_session_token')?.value ?? '';
}

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAdminToken()}` },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// Click a service row in the Settings left sidebar by exact id (the id lives in a
// `span.tracking-wide`; the click bubbles to the owning row button).
function pickService(page: any, id: string) {
  return page.locator('span.tracking-wide', { hasText: new RegExp(`^${id}$`) });
}

// ── state captured once, restored after, so the run is non-destructive ───────
let TARGET_SVC = '';
let TARGET_METHOD = '';
let origLimits: any;
let origTasks: any;
let origBlacklist: string[] = [];

test.beforeAll(async () => {
  origLimits    = await rpc('setting.limit.get');
  origTasks     = await rpc('setting.task.get');
  origBlacklist = (await rpc('setting.blacklist.get')) || [];

  // Pick a real registered service that exposes methods (for the per-service tabs).
  const list = await rpc('system.service.list');
  const svc = (list || []).find(
    (s: any) => s?.id && s.id !== 'router' && Array.isArray(s.methods) && s.methods.length
  );
  if (!svc) throw new Error('no service with methods found in system.service.list');
  TARGET_SVC = svc.id;
  // Prefer a method not already blacklisted, so toggling reliably *adds* it.
  TARGET_METHOD = (svc.methods.find((m: any) => !origBlacklist.includes(m.name)) || svc.methods[0]).name;
});

test.afterAll(async () => {
  // Restore every global key we may have touched.
  await rpc('setting.limit.update', { rules: origLimits || {} }).catch(() => {});
  await rpc('setting.task.update', { whitelist: origTasks || {} }).catch(() => {});
  await rpc('setting.blacklist.update', { blacklist: origBlacklist || [] }).catch(() => {});
});

// ── tests ────────────────────────────────────────────────────────────────────

test('@settings overview — page mounts, service list renders', async ({ page }) => {
  await page.goto('/settings');

  await expect(page.getByText('SYSTEM SETTINGS')).toBeVisible();
  // Basic panel defaults to the Overview tab — hardcoded (locale-independent) labels.
  await expect(page.getByText('System Overview')).toBeVisible();
  await expect(page.getByText('Total Services')).toBeVisible();
  await expect(page.getByText('Blacklisted Methods')).toBeVisible();

  // The sidebar lists services from system.service.list — our target must be there.
  await expect(pickService(page, TARGET_SVC)).toBeVisible();
});

test('@settings global rate limits — load, edit, save persists', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'RATE LIMITS' }).click();

  const ta = page.locator('textarea');
  await expect(ta).not.toHaveValue('', { timeout: 10_000 }); // loaded from setting.limit.get

  const parsed = JSON.parse(await ta.inputValue());
  // Additive, inert probe prefix (no real method starts with `e2e_probe.`).
  parsed.prefixes = { ...(parsed.prefixes || {}), 'e2e_probe.': { window: 60, max: 999, by: 'ip' } };
  await ta.fill(JSON.stringify(parsed, null, 2));

  await page.getByRole('button', { name: 'SAVE CONFIGURATION' }).click();
  await expect(page.getByText('Configuration updated successfully')).toBeVisible({ timeout: 8_000 });

  // Round-trip: the write reached Redis via setting.limit.update.
  const rules = await rpc('setting.limit.get');
  expect(rules.prefixes?.['e2e_probe.']).toMatchObject({ window: 60, max: 999, by: 'ip' });
});

test('@settings per-service task permissions — scoped load, edit, save persists', async ({ page }) => {
  await page.goto('/settings');
  await pickService(page, TARGET_SVC).click();
  await page.getByRole('button', { name: 'TASK PERMISSIONS' }).click();

  const ta = page.locator('textarea');
  await expect(ta).not.toHaveValue('', { timeout: 10_000 }); // scoped config from setting.task.get

  const parsed = JSON.parse(await ta.inputValue());
  const SENTINEL = 'e2e.probe.method';
  parsed.allowMethods = Array.isArray(parsed.allowMethods) ? parsed.allowMethods : [];
  if (!parsed.allowMethods.includes(SENTINEL)) parsed.allowMethods.push(SENTINEL);
  await ta.fill(JSON.stringify(parsed, null, 2));

  await page.getByRole('button', { name: 'SAVE CONFIGURATION' }).click();
  await expect(page.getByText('Configuration updated successfully')).toBeVisible({ timeout: 8_000 });

  // Round-trip: the edit merged back under this service id and persisted.
  const wl = await rpc('setting.task.get');
  expect(wl[TARGET_SVC]?.allowMethods).toContain(SENTINEL);
});

test('@settings per-service permit blacklist — toggle method, save persists', async ({ page }) => {
  await page.goto('/settings');
  await pickService(page, TARGET_SVC).click();
  await page.getByRole('button', { name: 'PERMIT BLACKLIST' }).click();

  // Method chips render from the service's registered methods; toggle the target → blocked.
  const chip = page.getByRole('button', { name: TARGET_METHOD, exact: true });
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();

  await page.getByRole('button', { name: 'SAVE CONFIGURATION' }).click();
  // Blacklist save has no inline toast; the save settles, then verify via RPC.
  await expect(page.getByRole('button', { name: 'SAVE CONFIGURATION' })).toBeEnabled();
  await expect
    .poll(async () => (await rpc('setting.blacklist.get')).includes(TARGET_METHOD), { timeout: 8_000 })
    .toBe(true);
});

test('@settings security — lock control renders but is never fired', async ({ page }) => {
  // admin.self.lock closes the administrator port + ends the session. We assert the
  // control is present and idle, and DELIBERATELY never click it (it would tear down
  // the mesh for every other test).
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Security' }).click();

  await expect(page.getByText('Just-in-time Admin Access')).toBeVisible();
  const lockBtn = page.getByRole('button', { name: 'LOCK & END SESSION' });
  await expect(lockBtn).toBeVisible();
  await expect(lockBtn).toBeEnabled();

  // Sanity: still on settings, session intact (lock was not triggered).
  await expect(page).toHaveURL(/\/settings/);
});
