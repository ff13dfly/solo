import { test, expect } from '@playwright/test';
import path from 'path';

// Inject the operator auth state created by global-setup.ts (token + test router address).
test.use({ storageState: path.join(__dirname, '../../state/operator.json') });

test('@smoke operator: dashboard loads without redirect or JS crash', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  // If auth state is missing/expired the portal kicks to /login — surfaces a clear failure.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('body')).toBeVisible();
  expect(jsErrors, `JS errors on /dashboard: ${jsErrors.join('; ')}`).toHaveLength(0);
});

test('@smoke operator: nav routes render', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  // Sidebar/nav links the portal renders (DynamicRoutes etc.) — useful when extending this suite.
  const links = await page.locator('a[href^="/"]').allInnerTexts();
  console.log('[smoke] operator nav links:', links);

  await expect(page.locator('body')).toBeVisible();
  expect(jsErrors).toHaveLength(0);
});

// Copy this file per page/flow as you customize portal/operator. Patterns:
//   - guarded pages: assert not redirected to /login, then assert page-specific content
//   - write actions: drive the UI, then verify via the API helper or a follow-up read
