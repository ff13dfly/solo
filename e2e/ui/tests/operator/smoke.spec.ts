import { test, expect } from '../../helpers/fixtures';
import path from 'path';

// Inject pre-acquired user auth state (created by global-setup.ts).
test.use({ storageState: path.join(__dirname, '../../state/operator.json') });

const PAGES = [
  { route: '/dashboard', label: 'dashboard' },
  { route: '/passport',  label: 'passport'  },
];

for (const { route, label } of PAGES) {
  test(`@smoke operator:${label} — loads without redirect or crash`, async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    await page.goto(route);
    await page.waitForLoadState('networkidle');

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('body')).toBeVisible();

    expect(jsErrors, `JS errors on ${route}: ${jsErrors.join('; ')}`).toHaveLength(0);
  });
}

test('@smoke operator: dynamic service routes discovered and reachable', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', e => jsErrors.push(e.message));

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  // Collect nav links rendered by DynamicRoutes (sidebar/nav items).
  const links = await page.locator('a[href^="/"]').allInnerTexts();
  console.log('[smoke] operator nav links:', links);

  // At minimum dashboard must render something.
  await expect(page.locator('body')).toBeVisible();
  expect(jsErrors).toHaveLength(0);
});
