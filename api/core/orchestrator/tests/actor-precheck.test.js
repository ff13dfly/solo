/**
 * C4 minimal tier — actor-claim pre-check tests (governance.md §4 / AUDIT C4).
 *
 * The async (event) path executes under the shared service bot, so H6 checks the
 * BOT's permit — never the principal that CAUSED the event. A workflow that opts
 * in with `require_actor_permit: true` additionally demands the trigger actor's
 * OWN permit cover the whole footprint (runner §2.6, fail-closed).
 *
 * Harness note: h.run(id, input, headers, callerUid, opts) — callerUid is the
 * EXECUTING identity (bot on the async path); opts.actorClaim is the threaded
 * envelope provenance ({ actor, source }); opts.triggerSource makes the run an
 * event-triggered one (workflow must allow 'event' in allowed_triggers).
 *
 * The critical assertion mirrors footprint-precheck: on rejection, ZERO business
 * steps must have executed.
 */
const { createHarness } = require('./utils/harness');

// The executing bot is wide (allow_all) — exactly the confused-deputy setup:
// H6 passes trivially, only the actor pre-check can block.
const BOT_PERMIT   = { allow_all: true };
const ACTOR_FULL   = { allow_all: false, services: { ledger: ['ledger.transfer'], mail: ['mail.send'] } };
const ACTOR_PARTIAL = { allow_all: false, services: { ledger: ['ledger.transfer'] } }; // mail.send missing

const BOT = 'system.orchestrator';

// Event-triggered workflow, actor gate ON.
const gatedWorkflow = {
    id: 'wf_actor_gated',
    category: 'process',
    name: 'Actor-gated workflow',
    desc: 'require_actor_permit:true — event triggers must carry a resolvable, covered actor',
    allowed_triggers: ['sync', 'event'],
    require_actor_permit: true,
    steps: [
        { id: 's1', service: 'ledger', method: 'ledger.transfer', params: { amount: 100 } },
        { id: 's2', service: 'mail',   method: 'mail.send',       params: { to: 'x@example.com' } },
    ],
};

// Same shape, gate OFF (default) — the 只加不破 baseline.
const openWorkflow = { ...gatedWorkflow, id: 'wf_actor_open', require_actor_permit: false };

describe('C4 minimal — actor-claim pre-check', () => {
    let h;
    let permits; // uid → permit returned by the user.permit.get stub

    beforeEach(async () => {
        h = await createHarness();
        permits = { [BOT]: BOT_PERMIT };
        h.mock.on('user.permit.get', (params) => {
            const p = permits[params.uid];
            if (!p) { const e = new Error('User not found'); e.rpcCode = -32001; throw e; }
            return p;
        });
        h.mock.on('ledger.transfer', () => ({ approved: true, txId: 'tx-1' }));
        h.mock.on('mail.send',       () => ({ delivered: true }));
    });
    afterEach(() => h.stop());

    const eventOpts = (actorClaim) => ({ triggerSource: 'event:EVENT:E2E:TEST', triggerId: '1-0', actorClaim });

    // ── 1. Default off — existing behavior untouched (只加不破) ────────────────

    test('flag off: event run with an uncovered actor still executes (advisory tier)', async () => {
        permits['uid-weak'] = ACTOR_PARTIAL;
        await h.seedWorkflow(openWorkflow);

        const res = await h.run(openWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'uid-weak', source: 'system.nexus' }));
        expect(res.status).toBe('completed');
        // Only the H6 fetch for the BOT — the actor's permit is never fetched.
        expect(h.mock.count('user.permit.get')).toBe(1);
    });

    // ── 2. Enforcement: rejection paths (all BEFORE any step) ─────────────────

    test('no actor claim → 403, zero steps executed', async () => {
        await h.seedWorkflow(gatedWorkflow);

        await expect(h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts(null)))
            .rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count('ledger.transfer')).toBe(0);
        expect(h.mock.count('mail.send')).toBe(0);
    });

    test('non-resolvable provenance (sentinel:{id}) → 403 fail-closed, no permit fetch for it', async () => {
        await h.seedWorkflow(gatedWorkflow);

        const err = await h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'sentinel:snt-1', source: 'system.nexus' })).catch(e => e);
        expect(err.code).toBe(-32005);
        expect(err.message).toMatch(/not a resolvable identity/);
        expect(h.mock.count('ledger.transfer')).toBe(0);
        // Exactly one permit fetch happened — the H6 one for the bot, none for the actor.
        expect(h.mock.count('user.permit.get')).toBe(1);
    });

    test('anonymous actor → 403 fail-closed', async () => {
        await h.seedWorkflow(gatedWorkflow);

        await expect(h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'anonymous', source: 'collection' })))
            .rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count('ledger.transfer')).toBe(0);
    });

    test('actor permit lacks a footprint method → 403 listing the gap, zero steps', async () => {
        permits['uid-weak'] = ACTOR_PARTIAL;
        await h.seedWorkflow(gatedWorkflow);

        const err = await h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'uid-weak', source: 'collection' })).catch(e => e);
        expect(err.code).toBe(-32005);
        expect(err.message).toMatch(/mail\.send/);
        expect(h.mock.count('ledger.transfer')).toBe(0);
        expect(h.mock.count('mail.send')).toBe(0);
    });

    test('unknown actor uid → 403 (permanent policy rejection, not retryable)', async () => {
        await h.seedWorkflow(gatedWorkflow);

        await expect(h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'uid-ghost', source: 'collection' })))
            .rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count('ledger.transfer')).toBe(0);
    });

    test('transient permit-service fault on the actor fetch → INTERNAL_ERROR (retryable), not 403', async () => {
        // BOT (H6) resolves fine; the actor fetch hits a plain fault (-32603).
        h.mock.on('user.permit.get', (params) => {
            if (params.uid === BOT) return BOT_PERMIT;
            throw new Error('user service down');            // no rpcCode → -32603
        });
        await h.seedWorkflow(gatedWorkflow);

        const err = await h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'uid-strong', source: 'collection' })).catch(e => e);
        expect(err.code).toBe(-32603);                       // worker will retry, not deadletter
        expect(h.mock.count('ledger.transfer')).toBe(0);
    });

    // ── 3. Enforcement: pass-through paths ────────────────────────────────────

    test('covered actor → both pre-checks pass, all steps execute', async () => {
        permits['uid-strong'] = ACTOR_FULL;
        await h.seedWorkflow(gatedWorkflow);

        const res = await h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'uid-strong', source: 'collection' }));
        expect(res.status).toBe('completed');
        // Two fetches: H6 (bot) + actor pre-check.
        expect(h.mock.count('user.permit.get')).toBe(2);
        expect(h.mock.count('ledger.transfer')).toBe(1);
        expect(h.mock.count('mail.send')).toBe(1);
    });

    test('bot-uid actor (system.*) resolves like any principal', async () => {
        permits['system.fulfillment'] = ACTOR_FULL;
        await h.seedWorkflow(gatedWorkflow);

        const res = await h.run(gatedWorkflow.id, {}, {}, BOT, eventOpts({ actor: 'system.fulfillment', source: 'system.fulfillment' }));
        expect(res.status).toBe('completed');
    });

    test('sync run skips the actor gate — caller IS the actor, H6 already covers it', async () => {
        permits['uid-strong'] = ACTOR_FULL;
        await h.seedWorkflow(gatedWorkflow);

        // No actorClaim, sync trigger: must NOT be rejected by the actor gate.
        const res = await h.run(gatedWorkflow.id, {}, {}, 'uid-strong');
        expect(res.status).toBe('completed');
        expect(h.mock.count('user.permit.get')).toBe(1); // H6 only
    });

    // ── 4. Provenance threading (advisory tier is still audited) ──────────────

    test('$context.trigger_actor resolves in step params', async () => {
        const wf = {
            ...gatedWorkflow,
            id: 'wf_actor_ctx',
            steps: [{ id: 's1', service: 'mail', method: 'mail.send', params: { to: 'ops', causedBy: '$context.trigger_actor' } }],
        };
        permits['uid-strong'] = { allow_all: false, services: { mail: ['mail.send'] } };
        await h.seedWorkflow(wf);

        await h.run(wf.id, {}, {}, BOT, eventOpts({ actor: 'uid-strong', source: 'collection' }));
        expect(h.mock.lastParams('mail.send').causedBy).toBe('uid-strong');
    });
});
