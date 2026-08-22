// Runtime config injection point — served at /config.js and loaded by index.html before the app.
// Overwritten at DEPLOY time to point the mobile client at its Router gateway, e.g.:
//   window.__SOLO_ROUTER__ = 'https://router.example.com/';
// Left empty in local dev: lib/routerManager.ts falls back to https://localhost:8800/.
//
// ⚠️ 这个空存根不只是「让 dev server 不 404」——**没有它，子路径构建会静默坏掉**：
// Vite 只把 index.html 里那些能在 public/ 里找到的绝对路径按 base 重写。缺了本文件时，
// `<script src="/config.js">` 原样留在产物里，于是 --base /mobile/ 构建出来的页面会去
// 请求站点根的 /config.js（404），Router 地址悄悄回落到 routerManager 的兜底值。
// portal/system 与 portal/operator 一直有这份存根，mobile 此前漏了（2026-08-22 补）。
