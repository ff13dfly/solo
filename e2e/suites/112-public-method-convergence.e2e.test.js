/**
 * Suite 112 · Public-method convergence — second narrowing pass.
 *
 * Continues the passport thesis (suite 111: "passport mode narrows the anonymous attack
 * surface"). With passport, every caller has a session, so methods that had no legitimate
 * anonymous consumer were flipped public:true → false in their service introspection
 * (Phase-3 capMap). This suite proves, per method:
 *   - anonymous (no token) → AUTH_REQUIRED (-32001): no longer reachable unauthenticated.
 *   - an authenticated (admin, allow_all) session → REACHES the handler (never a denial;
 *     may still error on params / not-found / backend, which is fine).
 *
 * storage.asset.get/resolve were narrowed too (this pass): the anonymous public path for a
 * public asset is the standalone /file/:id route (its own visibility gate, independent of the
 * RPC public flag), so the RPC reads carry no legitimate anonymous consumer. The
 * login/health/discovery surface must remain open and is intentionally NOT here.
 */
const { rpc } = require('../lib/client');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

// Methods narrowed this pass + minimal params so the admin call reaches the handler.
// anonOnly: skip the admin probe (agent.chat would dial the LLM — slow/costly; the
// convergence point is the anon denial, which is enforced at checkAccess before any LLM call).
const NARROWED = [
    { method: 'agent.providers',                params: {} },
    { method: 'agent.chat',                     params: { text: 'hi' }, anonOnly: true },
    { method: 'fulfillment.instance.get',       params: { id: `bogus-${process.pid}` } },
    { method: 'fulfillment.instance.list',      params: {} },
    { method: 'orchestrator.workflow.snapshot', params: {} },
    { method: 'storage.asset.upload',           params: { file: Buffer.from('x').toString('base64'), filename: 'conv.txt', mimeType: 'text/plain' } },
    // Reads narrowed this pass — anon uses /file/:id (own visibility gate); RPC needs a session.
    // Admin (allow_all) reaches the handler → NOT_FOUND for a well-formed but absent id.
    { method: 'storage.asset.get',              params: { id: `bogus-${process.pid}` } },
    { method: 'storage.asset.resolve',          params: { id: `bogus-${process.pid}` } },
    // Reading a profile now needs a permit — anon can no longer harvest PII (email/tier) by uid.
    // Own tier is surfaced by user.login.verify instead (see suite 70). Admin (allow_all) reaches
    // the handler → USER_NOT_FOUND for a well-formed but absent uid (a non-denial error).
    { method: 'user.profile',                   params: { uid: 'A'.repeat(16) } },
];

// Access-control denial codes — what a narrowed method must return to an anon caller, and
// what an authenticated caller must NEVER see (proving it cleared checkAccess).
const DENIAL = [-32001, -32003, -32005, -32604];

gate('112 · public-method convergence (narrowed methods reject anon, admit a session)', () => {
    for (const { method, params, anonOnly } of NARROWED) {
        test(`${method}: anon → AUTH_REQUIRED${anonOnly ? '' : '; admin session reaches the handler'}`, async () => {
            // Anonymous (no token): formerly public → now gated (denied at checkAccess).
            const anon = await rpc(method, params);
            V.assertRpcError(anon, -32001, `anon ${method} must be AUTH_REQUIRED (no longer public)`);

            if (anonOnly) return;   // e.g. agent.chat — don't dial the LLM just to prove access

            // Authenticated (admin allow_all): clears checkAccess. It may still carry a
            // non-denial error (bogus id → NOT_FOUND, backend, etc.) — just never a denial.
            const authed = await rpc(method, params, ADMIN_TOKEN);
            if (authed.error) {
                expect(DENIAL).not.toContain(authed.error.code);
            }
        }, 30_000);
    }
});
