/**
 * Hermetic unit test for passport SELF-SERVICE issuance (OTP).
 * spec-passport-self-issuance.md §4/§8. Fake redis + fake role/relay + real passport crypto.
 *
 * Covers: closed fail-closed, otp/pending modes, anti-enumeration (uniform response), OTP
 * delivery via relay, wrong-code attempts + lockout, fail-closed defaultRole (non-row-isolated),
 * and the full round-trip otpRequest → otpVerify → passport.verify → restricted session.
 */
const createPassport = require('../logic/passport');

const BASE_REDIS = {
    sessionPrefix: 'session:',
    userSessionsPrefix: 'USER:SESSIONS:',
    role: { prefix: 'USER:ROLE:', idsSet: 'USER:ROLE:IDS' },
    passport: {
        prefix: 'USER:PASSPORT:', idsSet: 'USER:PASSPORT:IDS',
        saltPrefix: 'PASSPORT:SALT:', proofPrefix: 'PASSPORT:PROOFS:',
        otpPrefix: 'USER:PASSPORT:OTP:', lockPrefix: 'USER:PASSPORT:LOCK:',
    },
};

function makeConfig() {
    return {
        redis: BASE_REDIS,
        passport: {
            issuance: { default: 'closed', byApp: { app1: 'otp', apprev: 'pending' } },
            defaultRole: { default: null, byApp: { app1: 'external' } },
            otp: { codeLen: 6, ttlSec: 300, maxAttempts: 3, lockoutSec: 900, echo: true },
        },
    };
}

// Fake redis with TTL + NX awareness (the OTP path needs set{EX}, ttl, del; verify needs setEx/expire).
function fakeRedis() {
    const store = new Map(), exp = new Map(), hashes = new Map(), sets = new Map();
    const now = () => Date.now();
    const live = (k) => { if (exp.has(k) && exp.get(k) <= now()) { store.delete(k); exp.delete(k); } return store.has(k); };
    const hOf = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    const sOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    return {
        store, exp,
        async get(k) { return live(k) ? store.get(k) : null; },
        async set(k, v, opts = {}) {
            if (opts.NX && live(k)) return null;
            store.set(k, v);
            if (opts.EX) exp.set(k, now() + opts.EX * 1000); else exp.delete(k);
            return 'OK';
        },
        async del(k) { const had = store.delete(k); exp.delete(k); sets.delete(k); hashes.delete(k); return had ? 1 : 0; },
        async incr(k) { const cur = live(k) ? parseInt(store.get(k) || '0', 10) : 0; const next = cur + 1; store.set(k, String(next)); return next; },
        async ttl(k) { if (!live(k)) return -2; if (!exp.has(k)) return -1; return Math.ceil((exp.get(k) - now()) / 1000); },
        async sAdd(k, v) { sOf(k).add(v); return 1; },
        async sMembers(k) { return [...sOf(k)]; },
        async hSet(k, f, v) { hOf(k).set(f, v); return 1; },
        async hGet(k, f) { return hOf(k).has(f) ? hOf(k).get(f) : null; },
        async hKeys(k) { return [...hOf(k).keys()]; },
        async expire(k, sec) { if (!store.has(k)) return 0; exp.set(k, now() + sec * 1000); return 1; },
        async setEx(k, _t, v) { store.set(k, v); return 'OK'; },
        multi() {
            const ops = [];
            const m = {
                set: (k, v) => { ops.push(() => store.set(k, v)); return m; },
                setEx: (k, _t, v) => { ops.push(() => store.set(k, v)); return m; },
                sAdd: (k, v) => { ops.push(() => sOf(k).add(v)); return m; },
                hSet: (k, f, v) => { ops.push(() => hOf(k).set(f, v)); return m; },
                expire: () => { ops.push(() => {}); return m; },
                del: (k) => { ops.push(() => { store.delete(k); }); return m; },
                async exec() { ops.forEach((fn) => fn()); return []; },
            };
            return m;
        },
    };
}

function fakeRole({ rowIsolated = true } = {}) {
    return {
        async get({ role }) { if (['external', 'guest'].includes(role)) return { id: role }; throw { code: -32002, message: `role ${role} not found` }; },
        async resolve(role, ownerValue) {
            const constraints = rowIsolated ? { $owner: { field: 'owner', value: ownerValue } } : {};
            return { allow_all: false, services: { collection: ['*'] }, constraints };
        },
    };
}

function fakeRelay() {
    const calls = [];
    return { calls, async call(method, params) { calls.push({ method, params }); return { success: true, provider: 'mock' }; } };
}

async function expectThrowCode(p, code) {
    try { await p; throw new Error('expected throw'); }
    catch (e) { expect(e.code).toBe(code); }
}

describe('passport.otpRequest — issuance gate + delivery', () => {
    test('closed app (default) → FORBIDDEN, nothing stored', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        await expectThrowCode(P.otpRequest({ anchor: 'a@x.com', channel: 'email' }), -32005);
        expect(r.store.size).toBe(0);
    });

    test('otp app → pending_otp + devCode + stores hashed OTP + delivers via gateway', async () => {
        const r = fakeRedis(); const relay = fakeRelay();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay });
        const out = await P.otpRequest({ anchor: 'a@x.com', channel: 'email', app: 'app1' });
        expect(out.status).toBe('pending_otp');
        expect(out.devCode).toMatch(/^\d{6}$/);
        // stored hashed, NOT plaintext
        const raw = await r.get('USER:PASSPORT:OTP:a@x.com');
        expect(raw).toBeTruthy();
        expect(raw).not.toContain(out.devCode);
        // delivered
        expect(relay.calls).toHaveLength(1);
        expect(relay.calls[0].method).toBe('gateway.email.send');
        expect(relay.calls[0].params.content).toContain(out.devCode);
    });

    test('anti-enumeration: existing vs unknown anchor → identical response shape', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        await P.register({ anchor: 'known@x.com', role: 'external', deviceToken: 'dt-seed' });
        const a = await P.otpRequest({ anchor: 'known@x.com', channel: 'email', app: 'app1' });
        const b = await P.otpRequest({ anchor: 'brand-new@x.com', channel: 'email', app: 'app1' });
        expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());   // {status, devCode}
        expect(a.status).toBe(b.status);
    });

    test('best-effort delivery: relay failure does NOT throw', async () => {
        const r = fakeRedis();
        const boom = { async call() { throw new Error('gateway down'); } };
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: boom });
        const out = await P.otpRequest({ anchor: 'a@x.com', channel: 'email', app: 'app1' });
        expect(out.status).toBe('pending_otp');   // still pending despite delivery failure
    });

    test('sms channel WITH template → gateway.sms.send in TEMPLATE shape (phone/templateId/variables), not free-form', async () => {
        const r = fakeRedis(); const relay = fakeRelay();
        const cfg = makeConfig();
        cfg.passport.otp.smsTemplateId = 'tpl-otp-1';
        const P = createPassport(r, cfg, { role: fakeRole(), relay });
        const out = await P.otpRequest({ anchor: '+8613800138000', channel: 'sms', app: 'app1' });
        expect(out.status).toBe('pending_otp');
        expect(relay.calls).toHaveLength(1);
        const { method, params } = relay.calls[0];
        expect(method).toBe('gateway.sms.send');
        // template contract — providers (Aliyun/Twilio) reject free-form text
        expect(params).toEqual({ phone: '+8613800138000', templateId: 'tpl-otp-1', variables: { code: out.devCode, ttl: 5 } });
        expect(params).not.toHaveProperty('content');
        expect(params).not.toHaveProperty('to');
    });

    test('sms channel WITHOUT configured template → fail-soft no-op (no relay call), still pending', async () => {
        const r = fakeRedis(); const relay = fakeRelay();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay });   // no smsTemplateId
        const out = await P.otpRequest({ anchor: '+8613800138000', channel: 'sms', app: 'app1' });
        expect(out.status).toBe('pending_otp');   // OTP still stored; verify works if code reaches the user another way
        expect(relay.calls).toHaveLength(0);       // SMS not attempted without a template
        expect(await r.get('USER:PASSPORT:OTP:+8613800138000')).toBeTruthy();
    });
});

describe('passport.otpRequest — per-anchor request throttle', () => {
    test('exceeding requestMax within the window → RATE_LIMIT_EXCEEDED (-32029) with retry_after', async () => {
        const r = fakeRedis(); const cfg = makeConfig();
        cfg.passport.otp.requestMax = 2; cfg.passport.otp.requestWindowSec = 60;
        const P = createPassport(r, cfg, { role: fakeRole(), relay: fakeRelay() });
        await P.otpRequest({ anchor: 't@x.com', channel: 'email', app: 'app1' });   // 1
        await P.otpRequest({ anchor: 't@x.com', channel: 'email', app: 'app1' });   // 2
        try {
            await P.otpRequest({ anchor: 't@x.com', channel: 'email', app: 'app1' }); // 3 → over budget
            throw new Error('expected throw');
        } catch (e) {
            expect(e.code).toBe(-32029);
            expect(e.data.retry_after).toBeGreaterThan(0);
        }
    });

    test('throttle is per-anchor — a different anchor is unaffected', async () => {
        const r = fakeRedis(); const cfg = makeConfig();
        cfg.passport.otp.requestMax = 1;
        const P = createPassport(r, cfg, { role: fakeRole(), relay: fakeRelay() });
        await P.otpRequest({ anchor: 'x@x.com', channel: 'email', app: 'app1' });
        await expectThrowCode(P.otpRequest({ anchor: 'x@x.com', channel: 'email', app: 'app1' }), -32029);
        const ok = await P.otpRequest({ anchor: 'y@x.com', channel: 'email', app: 'app1' });
        expect(ok.status).toBe('pending_otp');   // independent budget
    });

    test('closed app rejects before spending a throttle slot', async () => {
        const r = fakeRedis(); const cfg = makeConfig();
        cfg.passport.otp.requestMax = 1;
        const P = createPassport(r, cfg, { role: fakeRole(), relay: fakeRelay() });
        await expectThrowCode(P.otpRequest({ anchor: 'z@x.com', channel: 'email' }), -32005);   // default app = closed
        const ok = await P.otpRequest({ anchor: 'z@x.com', channel: 'email', app: 'app1' });     // slot not spent → still allowed
        expect(ok.status).toBe('pending_otp');
    });
});

describe('passport.otpVerify — proof + provisioning', () => {
    async function seedOtp(P, anchor = 'u@x.com', app = 'app1') {
        const { devCode } = await P.otpRequest({ anchor, channel: 'email', app });
        return devCode;
    }

    test('correct code → issues deviceToken + binds default role + creates ACTIVE entity', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        const code = await seedOtp(P);
        const out = await P.otpVerify({ anchor: 'u@x.com', otp: code, app: 'app1' });
        expect(out.role).toBe('external');
        expect(out.deviceToken).toBeTruthy();
        expect(out.deviceId).toBeTruthy();
        const ent = JSON.parse(await r.get('USER:PASSPORT:u@x.com'));
        expect(ent.status).toBe('ACTIVE');
        expect(ent.role).toBe('external');
        // OTP consumed (one-time)
        expect(await r.get('USER:PASSPORT:OTP:u@x.com')).toBeNull();
    });

    test('wrong code → UNAUTHORIZED; after maxAttempts → lockout', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        await seedOtp(P);
        await expectThrowCode(P.otpVerify({ anchor: 'u@x.com', otp: '000000', app: 'app1' }), -32003);
        await expectThrowCode(P.otpVerify({ anchor: 'u@x.com', otp: '000000', app: 'app1' }), -32003);
        await expectThrowCode(P.otpVerify({ anchor: 'u@x.com', otp: '000000', app: 'app1' }), -32003); // 3rd → lockout
        expect(await r.get('USER:PASSPORT:LOCK:u@x.com')).toBe('1');
        // even the right code is now rejected while locked
        await expectThrowCode(P.otpVerify({ anchor: 'u@x.com', otp: '123456', app: 'app1' }), -32003);
    });

    test('no pending OTP → UNAUTHORIZED', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        await expectThrowCode(P.otpVerify({ anchor: 'never@x.com', otp: '123456', app: 'app1' }), -32003);
    });

    test('fail-closed: defaultRole not row-isolated → INTERNAL_ERROR, no issuance', async () => {
        const r = fakeRedis();
        const cfg = makeConfig();
        cfg.passport.defaultRole.byApp.app1 = 'guest';                 // guest exists but...
        const P = createPassport(r, cfg, { role: fakeRole({ rowIsolated: false }), relay: fakeRelay() }); // ...no $owner
        const code = await seedOtp(P);
        await expectThrowCode(P.otpVerify({ anchor: 'u@x.com', otp: code, app: 'app1' }), -32603);
    });

    test('pending mode → PENDING entity, no device token', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        const code = await seedOtp(P, 'p@x.com', 'apprev');
        const out = await P.otpVerify({ anchor: 'p@x.com', otp: code, app: 'apprev' });
        expect(out.status).toBe('pending_review');
        expect(out.deviceToken).toBeUndefined();
        const ent = JSON.parse(await r.get('USER:PASSPORT:p@x.com'));
        expect(ent.status).toBe('PENDING');
    });
});

describe('full self-service round-trip', () => {
    test('otpRequest → otpVerify → passport.verify mints a kind:external session', async () => {
        const r = fakeRedis();
        const P = createPassport(r, makeConfig(), { role: fakeRole(), relay: fakeRelay() });
        const { devCode } = await P.otpRequest({ anchor: 'round@x.com', channel: 'email', app: 'app1' });
        const issued = await P.otpVerify({ anchor: 'round@x.com', otp: devCode, app: 'app1' });

        // the issued device token must authenticate via the existing public verify()
        const sess = await P.verify({ anchor: 'round@x.com', deviceId: issued.deviceId, deviceToken: issued.deviceToken });
        expect(sess.token).toBeTruthy();
        expect(sess.role).toBe('external');
        const stored = JSON.parse(await r.get(`session:${sess.token}`));
        expect(stored.kind).toBe('external');
        expect(stored.permit.constraints.$owner.value).toBe('round@x.com');   // row-isolated to the anchor
    });
});
