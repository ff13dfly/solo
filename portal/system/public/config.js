// Runtime config injection point — served at /config.js and loaded by index.html before the app.
// Overwritten at DEPLOY time to point the system portal at its Router gateway, e.g.:
//   window.__SOLO_ROUTER__ = 'https://router.example.com/';
//   window.__SOLO_SYSTEM_NAME__ = 'MSO';
//   window.__SOLO_SYSTEM_DESCRIPTION__ = 'MSO 客户生产网关。';
// Left empty in local dev: utils/routerManager.ts falls back to https://localhost:8800/,
// utils/branding.ts falls back to 'SYSTEM' / the i18n default description.
// (This stub exists so the dev server / build don't 404 on the index.html <script> tag.)
