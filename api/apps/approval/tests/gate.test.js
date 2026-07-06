/**
 * Multi-signature approval gate (VERSION.md §3.1) — hermetic unit test.
 *
 * Drives logic/gate.js with the shared fake redis + a fake relay that serves
 * approver public keys (mirroring user.key.public). Real tweetnacl signatures.
 *
 * Covered:
 *   - open creates an OPEN gate with the binding digest + threshold + expiry
 *   - sign verifies the Ed25519 signature against the approver's published key
 *   - m-of-n: flips APPROVED only at the threshold; bad/duplicate/self signatures rejected
 *   - retired (history) keys still verify; wrong digest does not
 *   - expired gate fails closed
 */
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const createGate = require('../logic/gate');
const { makeFakeRedis } = require('./utils/fake-redis');
const config = require('../config');

// A keyring: uid -> { publicKey, sign(digest) }
function makeKeyring() {
    const keys = {};
    return {
        add(uid) {
            const kp = nacl.sign.keyPair();
            keys[uid] = {
                publicKey: bs58.encode(Buffer.from(kp.publicKey)),
                secret: kp.secretKey,
                history: [],
            };
            return keys[uid].publicKey;
        },
        rotate(uid) {
            keys[uid].history.push(keys[uid].publicKey);
            const kp = nacl.sign.keyPair();
            keys[uid].publicKey = bs58.encode(Buffer.from(kp.publicKey));
            keys[uid].secret = kp.secretKey;
            return keys[uid].publicKey;
        },
        signWith(uid, secret, digest) {
            return bs58.encode(Buffer.from(nacl.sign.detached(Buffer.from(digest, 'utf8'), secret)));
        },
        sign(uid, digest) {
            return this.signWith(uid, keys[uid].secret, digest);
        },
        relay() {
            return {
                async call(method, params) {
                    if (method !== 'user.key.public') throw new Error(`unexpected relay call ${method}`);
                    const k = keys[params.uid];
                    if (!k) return { uid: params.uid, publicKey: null, history: [] };
                    return { uid: params.uid, publicKey: k.publicKey, history: k.history };
                },
            };
        },
        _keys: keys,
    };
}

const DIGEST = 'deadbeef'.repeat(8);   // 64 hex chars

describe('§3.1 approval gate — open', () => {
    test('creates an OPEN gate binding digest + threshold + expiry', async () => {
        const ring = makeKeyring();
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 'workflow:wf1:v2', digest: DIGEST, requiredSigners: 2, submitterUid: 'uid-sub' });
        expect(g.state).toBe('OPEN');
        expect(g.requiredSigners).toBe(2);
        expect(g.digest).toBe(DIGEST);
        expect(g.expiresAt).toBeGreaterThan(Date.now());
    });

    test('rejects bad digest', async () => {
        const ring = makeKeyring();
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        await expect(gate.open({ subject: 's', digest: 'nothex!' })).rejects.toMatchObject({ code: -32602 });
    });
});

describe('§3.1 approval gate — sign (m-of-n)', () => {
    test('1-of-1: one valid signature flips APPROVED', async () => {
        const ring = makeKeyring();
        ring.add('uid-appr');
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, submitterUid: 'uid-sub' });

        const res = await gate.sign({ id: g.id, approverUid: 'uid-appr', signature: ring.sign('uid-appr', DIGEST) });
        expect(res).toMatchObject({ state: 'APPROVED', signed: 1, required: 1 });
    });

    test('2-of-2: stays OPEN after one, APPROVED after the second distinct signer', async () => {
        const ring = makeKeyring();
        ring.add('uid-a'); ring.add('uid-b');
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 2, submitterUid: 'uid-sub' });

        const r1 = await gate.sign({ id: g.id, approverUid: 'uid-a', signature: ring.sign('uid-a', DIGEST) });
        expect(r1).toMatchObject({ state: 'OPEN', signed: 1, required: 2 });
        const r2 = await gate.sign({ id: g.id, approverUid: 'uid-b', signature: ring.sign('uid-b', DIGEST) });
        expect(r2).toMatchObject({ state: 'APPROVED', signed: 2 });
    });

    test('a signature over the WRONG digest does not verify', async () => {
        const ring = makeKeyring();
        ring.add('uid-a');
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, submitterUid: 'uid-sub' });
        await expect(gate.sign({ id: g.id, approverUid: 'uid-a', signature: ring.sign('uid-a', 'aa'.repeat(32)) }))
            .rejects.toMatchObject({ code: -32001 });   // INVALID_SIGNATURE
    });

    test('submitter cannot self-sign', async () => {
        const ring = makeKeyring();
        ring.add('uid-sub');
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, submitterUid: 'uid-sub' });
        await expect(gate.sign({ id: g.id, approverUid: 'uid-sub', signature: ring.sign('uid-sub', DIGEST) }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('the same approver cannot sign twice', async () => {
        const ring = makeKeyring();
        ring.add('uid-a');
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 2, submitterUid: 'uid-sub' });
        await gate.sign({ id: g.id, approverUid: 'uid-a', signature: ring.sign('uid-a', DIGEST) });
        await expect(gate.sign({ id: g.id, approverUid: 'uid-a', signature: ring.sign('uid-a', DIGEST) }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('approver with no key is rejected', async () => {
        const ring = makeKeyring();   // uid-a not added → no key
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, submitterUid: 'uid-sub' });
        await expect(gate.sign({ id: g.id, approverUid: 'uid-a', signature: bs58.encode(Buffer.alloc(64)) }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('a retired (history) key still verifies', async () => {
        const ring = makeKeyring();
        ring.add('uid-a');
        const oldSecret = ring._keys['uid-a'].secret;
        const sigWithOld = bs58.encode(Buffer.from(nacl.sign.detached(Buffer.from(DIGEST, 'utf8'), oldSecret)));
        ring.rotate('uid-a');   // current key changes; old one moves to history

        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, submitterUid: 'uid-sub' });
        const res = await gate.sign({ id: g.id, approverUid: 'uid-a', signature: sigWithOld });
        expect(res.state).toBe('APPROVED');
    });
});

describe('§3.1 approval gate — expiry / reject', () => {
    // Tamper a gate's stored expiresAt into the past (no fake timers needed).
    function backdate(redis, gateId) {
        for (const [k, v] of redis._kv) {
            let doc; try { doc = JSON.parse(v); } catch { continue; }
            if (doc && doc.id === gateId && doc.subject !== undefined && doc.state) {
                doc.expiresAt = Date.now() - 1000;
                redis._kv.set(k, JSON.stringify(doc));
                return true;
            }
        }
        return false;
    }

    test('signing an expired gate fails closed', async () => {
        const ring = makeKeyring();
        ring.add('uid-a');
        const redis = makeFakeRedis();
        const gate = createGate(redis, { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, expiresInSec: 1, submitterUid: 'uid-sub' });

        expect(backdate(redis, g.id)).toBe(true);

        await expect(gate.sign({ id: g.id, approverUid: 'uid-a', signature: ring.sign('uid-a', DIGEST) }))
            .rejects.toMatchObject({ code: -32005 });
        const after = await gate.get({ id: g.id });
        expect(after.state).toBe('EXPIRED');
    });

    test('reject moves OPEN → REJECTED and blocks further signing', async () => {
        const ring = makeKeyring();
        ring.add('uid-a');
        const gate = createGate(makeFakeRedis(), { config, relay: ring.relay() });
        const g = await gate.open({ subject: 's', digest: DIGEST, requiredSigners: 1, submitterUid: 'uid-sub' });
        const r = await gate.reject({ id: g.id, reason: 'looks wrong', byUid: 'uid-a' });
        expect(r.state).toBe('REJECTED');
        await expect(gate.sign({ id: g.id, approverUid: 'uid-a', signature: ring.sign('uid-a', DIGEST) }))
            .rejects.toMatchObject({ code: -32005 });
    });
});
