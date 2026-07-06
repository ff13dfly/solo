const config = require('../config');
const createLogic = require('../logic');
const { makeFakeRedis } = require('./utils/fake-redis');

const validPayload = [
    { op: 'UPDATE', field: 'price.amount', oldValue: 100, newValue: 80, meta: { desc: 'markdown' } },
];

describe('approval record state machine', () => {
    let logic;
    beforeEach(() => {
        logic = createLogic(makeFakeRedis(), { config });
    });

    test('request creates an INIT record with applicant + request attestation', async () => {
        const rec = await logic.record.request(
            { target: 'commodity:product:p1', payload: validPayload },
            { actor: 'u-applicant' },
        );

        expect(rec.state).toBe('INIT');
        expect(rec.applicant).toBe('u-applicant');
        expect(rec.evidence).toHaveLength(1);
        expect(rec.evidence[0]).toMatchObject({ stage: 'request', actor: 'u-applicant', method: 'server-attested', publicKey: null, signature: null });
        expect(rec.evidence[0].payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('request rejects an empty/invalid payload', async () => {
        await expect(logic.record.request({ target: 't', payload: [] }, {})).rejects.toMatchObject({ code: -32602 });
        await expect(logic.record.request({ target: 't', payload: [{ field: 'x' }] }, {})).rejects.toMatchObject({ code: -32602 });
        await expect(logic.record.request({ payload: validPayload }, {})).rejects.toMatchObject({ code: -32602 });
    });

    test('verify by a different actor moves INIT -> DISPATCHED and appends evidence', async () => {
        const rec = await logic.record.request({ target: 't', payload: validPayload }, { actor: 'u-applicant' });
        const verified = await logic.record.verify({ id: rec.id }, { actor: 'u-manager' });

        expect(verified.state).toBe('DISPATCHED');
        expect(verified.evidence).toHaveLength(2);
        expect(verified.evidence[1]).toMatchObject({ stage: 'verify', actor: 'u-manager' });
    });

    test('applicant cannot verify their own request', async () => {
        const rec = await logic.record.request({ target: 't', payload: validPayload }, { actor: 'u-applicant' });
        await expect(logic.record.verify({ id: rec.id }, { actor: 'u-applicant' })).rejects.toMatchObject({ code: -32005 });
    });

    test('full happy path: request -> verify -> confirm -> DONE', async () => {
        const rec = await logic.record.request({ target: 't', payload: validPayload }, { actor: 'u-applicant' });
        await logic.record.verify({ id: rec.id }, { actor: 'u-manager' });
        const done = await logic.record.confirm({ id: rec.id }, { actor: 'u-gm' });

        expect(done.state).toBe('DONE');
        expect(done.confirmedAt).toEqual(expect.any(Number));
        expect(done.evidence.map(e => e.stage)).toEqual(['request', 'verify', 'confirm']);
    });

    test('confirm on an INIT record is forbidden (illegal transition)', async () => {
        const rec = await logic.record.request({ target: 't', payload: validPayload }, { actor: 'u-applicant' });
        await expect(logic.record.confirm({ id: rec.id }, { actor: 'u-gm' })).rejects.toMatchObject({ code: -32005 });
    });

    test('reject from INIT moves to REJECTED and records the reason', async () => {
        const rec = await logic.record.request({ target: 't', payload: validPayload }, { actor: 'u-applicant' });
        const rejected = await logic.record.reject({ id: rec.id, reason: 'price floor breach' }, { actor: 'u-manager' });

        expect(rejected.state).toBe('REJECTED');
        expect(rejected.evidence[rejected.evidence.length - 1]).toMatchObject({ stage: 'reject', reason: 'price floor breach' });
    });

    test('a DONE record cannot be verified again', async () => {
        const rec = await logic.record.request({ target: 't', payload: validPayload }, { actor: 'u-applicant' });
        await logic.record.verify({ id: rec.id }, { actor: 'u-manager' });
        await logic.record.confirm({ id: rec.id }, { actor: 'u-gm' });
        await expect(logic.record.verify({ id: rec.id }, { actor: 'u-manager' })).rejects.toMatchObject({ code: -32005 });
    });

    test('list filters by target and state', async () => {
        const a = await logic.record.request({ target: 'svc:e:a', payload: validPayload }, { actor: 'u1' });
        await logic.record.request({ target: 'svc:e:b', payload: validPayload }, { actor: 'u1' });
        await logic.record.verify({ id: a.id }, { actor: 'u2' }); // a -> DISPATCHED

        const byTarget = await logic.record.list({ target: 'svc:e:b' });
        expect(byTarget.total).toBe(1);
        expect(byTarget.items[0].target).toBe('svc:e:b');

        const dispatched = await logic.record.list({ state: 'DISPATCHED' });
        expect(dispatched.total).toBe(1);
        expect(dispatched.items[0].id).toBe(a.id);
    });
});
