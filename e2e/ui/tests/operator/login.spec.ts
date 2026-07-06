import { test, expect } from '../../helpers/fixtures';
import { LoginPage } from '../../helpers/portals';

// These tests drive the login UI directly and do NOT use pre-acquired auth state.
// Same LoginPage page object as the system portal — both share the login-* testid contract.

const TEST_USER = process.env.TEST_USER || '';
const TEST_PASS = process.env.TEST_PASSWORD || '';

test.skip(!TEST_USER || !TEST_PASS, 'TEST_USER and TEST_PASSWORD env vars required for login tests');

test('@login operator: shows login form', async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await expect(login.username).toBeVisible();
  await expect(login.password).toBeVisible();
  await expect(login.submit).toBeVisible();
});

test('@login operator: successful login redirects to dashboard', async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await login.login(TEST_USER, TEST_PASS);

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
});

test('@login operator: wrong password stays on login', async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await login.login(TEST_USER, '__wrong__');

  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});
