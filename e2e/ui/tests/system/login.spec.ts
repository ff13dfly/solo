import { test, expect } from '../../helpers/fixtures';
import { LoginPage } from '../../helpers/portals';

// These tests drive the login UI directly and do NOT use pre-acquired auth state.
// Selectors come from the LoginPage page object (stable data-testid contract), not raw
// text/role queries — the form labels are i18n'd and would break text selectors.

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';

test.skip(!ADMIN_PASS, 'ADMIN_PASSWORD env var required for login tests');

test('@login system: shows login form', async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await expect(login.username).toBeVisible();
  await expect(login.password).toBeVisible();
  await expect(login.submit).toBeVisible();
});

test('@login system: successful login redirects to dashboard', async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await login.login(ADMIN_USER, ADMIN_PASS);

  // Login is async (handshake + log messages); wait for redirect off /login.
  await expect(page).toHaveURL(/\/(?!login)/, { timeout: 15_000 });
});

test('@login system: wrong password stays on login', async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await login.login(ADMIN_USER, '__wrong_password__');

  // Should stay on /login (failed handshake never redirects).
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});
