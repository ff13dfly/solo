/**
 * Suite 111 · Passport SELF-SERVICE issuance (OTP) + public-method convergence.
 * spec-passport-self-issuance.md.
 *
 * Proves the thesis "passport mode narrows the anonymous attack surface":
 *   1. A visitor with NO prior account self-issues a passport:
 *        otp.request → otp.verify (OTP proves anchor ownership) → device token
 *        → passport.verify → a restricted, row-isolated external session.
 *   2. storage.asset.multi — FORMERLY public (system.js + storage introspection) — is now
 *      auth-required: anonymous → AUTH_REQUIRED; the self-issued passport session → OK.
 *   3. Fail-closed: an app without configured issuance cannot self-issue (FORBIDDEN).
 *
 * The harness boots the user service (setup.js) with:
 *   PASSPORT_ISSUANCE_BYAPP={"e2e-passport":"otp"}
 *   PASSPORT_DEFAULT_ROLE_BYAPP={"e2e-passport":"e2e-external"}
 *   PASSPORT_OTP_ECHO=1   (echo returns the OTP code in the response — dev/test only)
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const APP = 'e2e-passport';
const ROLE = 'e2e-external';
const ANCHOR = `pp-${process.pid}@example.com`;
const STRAY = `wrong-${process.pid}@example.com`;

gate('111 · passport self-issuance (OTP) + public-method convergence', () => {
    let redis;
    let deviceToken, deviceId, sessionToken;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        if (!redis) return;
        for (const a of [ANCHOR, STRAY]) {
            const toks = await redis.sMembers(`USER:SESSIONS:${a}`).catch(() => []);
            for (const t of toks) await redis.del(`session:${t}`);
            await redis.del(`USER:PASSPORT:${a}`, `PASSPORT:SALT:${a}`, `PASSPORT:PROOFS:${a}`,
                `USER:SESSIONS:${a}`, `USER:PASSPORT:OTP:${a}`, `USER:PASSPORT:LOCK:${a}`);
            await redis.sRem('USER:PASSPORT:IDS', a);
        }
        await redis.del(`USER:ROLE:${ROLE}`);
        await redis.sRem('USER:ROLE:IDS', ROLE);
        await redis.quit();
    });

    test('① admin defines the row-isolated default role (ownerField, scope external)', async () => {
        const r = V.assertResult(await rpc('user.role.set', {
            role: ROLE,
            services: { collection: ['collection.payment.record', 'collection.payment.list'], storage: ['storage.asset.multi'] },
            ownerField: 'ownerId',
            scope: 'external',
        }, ADMIN_TOKEN), 'role.set');
        expect(r.role).toBe(ROLE);
    }, 30_000);

    test('② otp.request is PUBLIC (no token) → pending_otp + echoed devCode', async () => {
        const r = V.assertResult(await rpc('user.passport.otp.request', { anchor: ANCHOR, channel: 'email', app: APP }), 'otp.request');
        expect(r.status).toBe('pending_otp');
        expect(r.devCode).toMatch(/^\d{6}$/);   // echo mode (PASSPORT_OTP_ECHO=1)
    }, 30_000);

    test('③ otp.verify (PUBLIC) → issues device token + binds the configured default role', async () => {
        const req = V.assertResult(await rpc('user.passport.otp.request', { anchor: ANCHOR, channel: 'email', app: APP }), 'otp.request#2');
        const res = V.assertResult(await rpc('user.passport.otp.verify', { anchor: ANCHOR, otp: req.devCode, channel: 'email', app: APP, name: 'PP User' }), 'otp.verify');
        expect(res.role).toBe(ROLE);
        expect(res.deviceToken).toBeTruthy();
        expect(res.deviceId).toBeTruthy();
        deviceToken = res.deviceToken;
        deviceId = res.deviceId;
        const ent = JSON.parse(await redis.get(`USER:PASSPORT:${ANCHOR}`));
        expect(ent.status).toBe('ACTIVE');
        expect(ent.role).toBe(ROLE);
    }, 30_000);

    test('④ wrong OTP is rejected (proof actually enforced)', async () => {
        V.assertResult(await rpc('user.passport.otp.request', { anchor: STRAY, channel: 'email', app: APP }), 'otp.request#wrong');
        const bad = await rpc('user.passport.otp.verify', { anchor: STRAY, otp: '000000', channel: 'email', app: APP });
        V.assertRpcError(bad, -32003, 'wrong otp → UNAUTHORIZED');
    }, 30_000);

    test('⑤ passport.verify (PUBLIC) with the device token → restricted external session', async () => {
        const res = V.assertResult(await rpc('user.passport.verify', { anchor: ANCHOR, deviceId, deviceToken }), 'passport.verify');
        expect(res.token).toBeTruthy();
        expect(res.role).toBe(ROLE);
        sessionToken = res.token;
        const sess = JSON.parse(await redis.get(`session:${sessionToken}`));
        expect(sess.kind).toBe('external');
        expect(sess.uid).toBe(ANCHOR);
        expect(sess.permit.constraints.$owner.value).toBe(ANCHOR);   // row-isolated to this anchor
    }, 30_000);

    test('⑥ CONVERGENCE: storage.asset.multi (was public) → anon AUTH_REQUIRED, passport session OK', async () => {
        // Anonymous (no token): before the narrowing this returned a result; now it is gated.
        const anon = await rpc('storage.asset.multi', { ids: [`bogus-${process.pid}`] });
        V.assertRpcError(anon, -32001, 'anon storage.asset.multi must be AUTH_REQUIRED');

        // The SAME call carrying the self-issued passport session → admitted (permit grants it).
        const authed = V.assertResult(await rpc('storage.asset.multi', { ids: [`bogus-${process.pid}`] }, sessionToken), 'storage.asset.multi (passport session)');
        expect(Array.isArray(authed.items)).toBe(true);
    }, 30_000);

    test('⑦ fail-closed: an app without configured issuance cannot self-issue', async () => {
        const closed = await rpc('user.passport.otp.request', { anchor: `closed-${process.pid}@x.com`, channel: 'email', app: 'no-such-app' });
        V.assertRpcError(closed, -32005, 'closed app → FORBIDDEN');
    }, 30_000);
});
