/**
 * 93 · service events declaration — system.service.status includes events field.
 *
 * Verifies the events discovery pipeline end-to-end:
 *   service handlers/events.js  →  router capability refresh
 *   →  system.service.status { events }  →  portal can render EVENTS chips.
 *
 * Coverage:
 *   1. system.service.status includes events: { emits, subscribes } for all services
 *   2. Services with declared emits return non-empty arrays with required fields
 *   3. Services with no events return empty arrays (not null/undefined)
 *   4. emit entries have required fields: stream, type
 */
const { rpc } = require('../lib/client');
const { ADMIN_TOKEN } = require('../harness/identity');
const V = require('../lib/verify');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

// Services expected to have at least one emit declared
const SERVICES_WITH_EMITS = [
    { id: 'orchestrator', minEmits: 3 },
    { id: 'fulfillment',  minEmits: 1 },
    { id: 'nexus',        minEmits: 1 },
    { id: 'ingress',      minEmits: 1 },
];

// Services expected to have empty declarations (not an error — just no events yet)
const SERVICES_WITH_EMPTY_EVENTS = [
    'administrator', 'agent', 'gateway', 'notification',
    'user', 'approval', 'planner', 'storage',
];

gate('93 · service events declaration — events field in service status', () => {

    test('system.service.status includes events object for orchestrator', async () => {
        const res = await rpc('system.service.status', { serviceId: 'orchestrator' }, ADMIN_TOKEN);
        const status = V.assertResult(res, 'system.service.status[orchestrator]');

        expect(status.status).toBe('online');
        expect(status.events).toBeDefined();
        expect(typeof status.events).toBe('object');
        expect(Array.isArray(status.events.emits)).toBe(true);
        expect(Array.isArray(status.events.subscribes)).toBe(true);
    });

    test.each(SERVICES_WITH_EMITS)(
        'system.service.status[$id] has ≥$minEmits emit(s) with required fields',
        async ({ id, minEmits }) => {
            const res = await rpc('system.service.status', { serviceId: id }, ADMIN_TOKEN);
            const status = V.assertResult(res, `system.service.status[${id}]`);

            expect(status.events).toBeDefined();
            expect(Array.isArray(status.events.emits)).toBe(true);
            expect(status.events.emits.length).toBeGreaterThanOrEqual(minEmits);

            // Every emit entry must have stream + type
            for (const emit of status.events.emits) {
                expect(typeof emit.stream).toBe('string');
                expect(emit.stream.length).toBeGreaterThan(0);
                expect(typeof emit.type).toBe('string');
                expect(emit.type.length).toBeGreaterThan(0);
            }
        }
    );

    test.each(SERVICES_WITH_EMPTY_EVENTS)(
        'system.service.status[%s] returns events with empty arrays (not null)',
        async (id) => {
            const res = await rpc('system.service.status', { serviceId: id }, ADMIN_TOKEN);
            const status = V.assertResult(res, `system.service.status[${id}]`);

            // events field must exist and have array structure
            expect(status.events).toBeDefined();
            expect(Array.isArray(status.events.emits)).toBe(true);
            expect(Array.isArray(status.events.subscribes)).toBe(true);
            expect(status.events.emits.length).toBe(0);
        }
    );

    test('orchestrator emits include all three expected streams', async () => {
        const res = await rpc('system.service.status', { serviceId: 'orchestrator' }, ADMIN_TOKEN);
        const status = V.assertResult(res, 'system.service.status[orchestrator]');

        const streams = status.events.emits.map(e => e.stream);
        expect(streams).toContain('EVENT:WORKFLOW:RESULT');
        expect(streams).toContain('EVENT:WORKFLOW:STATUS');
        expect(streams).toContain('EVENT:WORKFLOW:NEEDS_GRANT');
    });

    test('fulfillment emits include FULFILLMENT:TRANSITIONED stream', async () => {
        const res = await rpc('system.service.status', { serviceId: 'fulfillment' }, ADMIN_TOKEN);
        const status = V.assertResult(res, 'system.service.status[fulfillment]');

        const streams = status.events.emits.map(e => e.stream);
        expect(streams).toContain('EVENT:FULFILLMENT:TRANSITIONED');
    });

    test('nexus has at least one subscribe declaration', async () => {
        const res = await rpc('system.service.status', { serviceId: 'nexus' }, ADMIN_TOKEN);
        const status = V.assertResult(res, 'system.service.status[nexus]');

        expect(status.events.subscribes.length).toBeGreaterThanOrEqual(1);
    });

    test('orchestrator has at least one subscribe declaration', async () => {
        const res = await rpc('system.service.status', { serviceId: 'orchestrator' }, ADMIN_TOKEN);
        const status = V.assertResult(res, 'system.service.status[orchestrator]');

        expect(status.events.subscribes.length).toBeGreaterThanOrEqual(1);
    });

    test('no ERROR:QUEUE entries after events discovery probes', async () => {
        const { connect } = require('../lib/redis');
        const redis = await connect();
        try {
            await V.assertNoErrors(redis, ['router', 'orchestrator', 'fulfillment', 'nexus', 'ingress']);
        } finally {
            await redis.disconnect();
        }
    });

});
