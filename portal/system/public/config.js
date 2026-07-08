// Runtime config injection point — served at /config.js and loaded by index.html before the app.
// Overwritten at DEPLOY time to point the system portal at its Router gateway, e.g.:
//   window.__SOLO_ROUTER__ = 'https://router.example.com/';
// Left empty in local dev: utils/routerManager.ts then falls back to https://localhost:8800/.
// (This stub exists so the dev server / build don't 404 on the index.html <script> tag.)
