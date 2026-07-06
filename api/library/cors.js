/**
 * library/cors.js — env-driven CORS policy, one knob for the whole fleet (toFix §6.5).
 *
 * Every service previously did `app.use(cors())` — wide open, fine for localhost
 * dev, a hole in production. This helper keeps dev behavior IDENTICAL by default
 * and lets a deployment close the surface with a single env var:
 *
 *   CORS_ORIGINS unset          → open (current dev behavior, nothing breaks)
 *   CORS_ORIGINS=none           → cross-origin denied (same-origin / curl only)
 *   CORS_ORIGINS=https://a.com,https://b.com
 *                               → exact-match allowlist
 *
 * Usage (replaces `app.use(cors())`):
 *   const cors = require('cors');
 *   const { corsOptionsFromEnv } = require('../../library/cors');
 *   app.use(cors(corsOptionsFromEnv()));
 *
 * NOTE: api/router/ is intentionally NOT migrated (CLAUDE.md §5 — router changes
 * require explicit authorization). Set its policy in a separate, approved change.
 */
function corsOptionsFromEnv(env = process.env) {
    const raw = (env.CORS_ORIGINS || '').trim();
    if (!raw) return {};                       // open — dev default, identical to cors()

    if (raw === 'none') {
        return { origin: false };              // deny all cross-origin requests
    }

    const allowlist = raw.split(',').map(s => s.trim()).filter(Boolean);
    return {
        origin(origin, cb) {
            // No Origin header (curl, server-to-server, same-origin) → allow.
            if (!origin) return cb(null, true);
            cb(null, allowlist.includes(origin));
        },
    };
}

module.exports = { corsOptionsFromEnv };
