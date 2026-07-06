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

module.exports = { portFor, urlFor };
