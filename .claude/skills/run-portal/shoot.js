/**
 * run-portal screenshot driver. Opens portal/system already authenticated (injects the
 * admin session + dev router URL into localStorage BEFORE app scripts run — the portal
 * reads `sys_session_token` for auth and `solomind:router_addresses` for the router), then
 * screenshots. Uses the chromium that ships with e2e/ui's Playwright (no extra install).
 *
 *   node shoot.js                       # reliability tour: Control + expanded Saga + Event Bus runs
 *   node shoot.js --route nexus/control # one page, by SPA path under /
 *
 * Env: PORTAL_URL (default http://localhost:9200) · ROUTER_URL (default http://localhost:8600/)
 *      TOKEN (default vis-admin-token) · OUT (default this skill dir)
 */
const path = require('path');
const REPO = path.join(__dirname, '..', '..', '..');
const { chromium } = require(path.join(REPO, 'e2e', 'ui', 'node_modules', 'playwright'));

const PORTAL = process.env.PORTAL_URL || 'http://localhost:9200';
const ROUTER = process.env.ROUTER_URL || 'http://localhost:8600/';
const TOKEN = process.env.TOKEN || 'vis-admin-token';
const OUT = process.env.OUT || __dirname;
const routeArg = (() => { const i = process.argv.indexOf('--route'); return i > -1 ? process.argv[i + 1] : null; })();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await ctx.addInitScript(([router, token]) => {
    localStorage.setItem('solomind:router_addresses', JSON.stringify([{ url: router, name: 'dev' }]));
    localStorage.setItem('solomind:current_router_index', '0');
    localStorage.setItem('sys_session_token', token);
    localStorage.setItem('sys_session_ts', String(Date.now()));
  }, [ROUTER, TOKEN]);
  const page = await ctx.newPage();
  const go = async (route, ms = 2600) => { await page.goto(`${PORTAL}/${route}`, { waitUntil: 'networkidle' }).catch(() => {}); await page.waitForTimeout(ms); };

  if (routeArg) {
    await go(routeArg);
    await page.screenshot({ path: `${OUT}/shot.png`, fullPage: true });
    console.log(`✓ ${OUT}/shot.png  (${page.url()})`);
  } else {
    await go('nexus/control');                                            // A (Re-drive) + B (Ops alerts)
    await page.screenshot({ path: `${OUT}/shot-automation.png`, fullPage: true });
    await page.getByText('vis-fail-1').first().click({ timeout: 3000 }).catch(() => {});  // expand → C
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/shot-compensation.png`, fullPage: true });
    await go('nexus/events', 1500);                                       // A (RETRY) in the Runs tab
    await page.getByText(/^RUNS$/i).first().click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/shot-events.png`, fullPage: true });
    console.log(`✓ ${OUT}/shot-{automation,compensation,events}.png`);
  }
  await browser.close();
})().catch(e => { console.error('shoot error:', e.message); process.exit(1); });
