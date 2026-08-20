//
// Port & URL resolver for Solo internal services.
//
// Two distinct lookups — do NOT conflate them:
//   portFor(name) — THIS process's OWN listen port (used as `port: portFor('self', N)`).
//     Resolution: process.env.PORT > global.__SOLO_PORTS__[name] > fallback.
//     PORT wins because a standalone invocation sets it to pin where this process binds.
//   urlFor(name)  — a FOREIGN service's address (used as `routerUrl: urlFor('router', N)`).
//     Resolution: global.__SOLO_PORTS__[name] > fallback. It MUST NOT consult
//     process.env.PORT — that env is THIS process's own port, not a peer's. Honoring it
//     made the Router (started with PORT=8600) resolve every peer to :8600 — itself —
//     so e.g. administratorServiceUrl pointed at the Router and admin methods 404'd.
//
// This module has no runtime dependencies and is safe to require from any
// config.js. It does NOT read SOLO_SERVICES_JSON itself — the bundle entry
// (deploy/gen-entry.js output) is responsible for populating global.__SOLO_PORTS__
// before any service config.js is evaluated.
//

// Shared resolution WITHOUT the self-PORT env: bundle map, then fallback.
function mapPort(name, fallback) {
  const map = global.__SOLO_PORTS__;
  if (map && map[name] != null) return Number(map[name]);
  return fallback;
}

function portFor(name, fallback) {
  const env = process.env.PORT && Number(process.env.PORT);
  if (env) return env;
  return mapPort(name, fallback);
}

function urlFor(name, fallbackPort) {
  // Foreign-service lookup — never the current process's own PORT (see header).
  const p = mapPort(name, fallbackPort);
  return p ? `http://localhost:${p}` : null;
}

//
// bindAddr(name) — which network interface THIS service should listen on.
//
// @why Until now every Solo service called `app.listen(PORT, cb)` with no host, which
//      makes Node bind `::` / 0.0.0.0 — EVERY interface. On a laptop that's invisible;
//      on a box with a public NIC it means the Router, the user service (accounts) and
//      storage are all reachable from outside the moment the process starts, and the
//      only way to stop it is a machine-level firewall. "Which service is exposed" is a
//      deployment decision that belongs in the project, not in some host's nftables.
//      (Reported from a runner deploy, 2026-08-14 — see docs/feedback/done/run-sh-no-per-app-env.md.)
//
// Resolution: <SERVICE>_BIND_ADDR > BIND_ADDR > undefined.
//
// @attention Returning **undefined** is deliberate and load-bearing: `listen(port, undefined, cb)`
//      is exactly equivalent to `listen(port, cb)` (verified against Node before relying on it),
//      so a project that sets neither variable keeps today's all-interfaces behavior byte for
//      byte. This is an opt-IN lockdown, not a silent change of default — flipping the default
//      to 127.0.0.1 would break every already-deployed stack whose reverse proxy, container
//      network or LB reaches the service from another host.
//
// The per-service form is what makes "expose one app, keep the rest local" expressible:
//      BIND_ADDR=127.0.0.1     CODER_BIND_ADDR=0.0.0.0
// …locks everything down and opens exactly one. deploy/run.sh's per-app `env` in
// services.json does the same job for private apps declared there.
function bindAddr(name) {
  const perService = name && process.env[`${String(name).toUpperCase()}_BIND_ADDR`];
  const addr = perService || process.env.BIND_ADDR;
  return addr && String(addr).trim() ? String(addr).trim() : undefined;
}

module.exports = { portFor, urlFor, bindAddr };
