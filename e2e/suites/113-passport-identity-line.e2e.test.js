/**
 * Suite 113 · Passport identity-line convergence — device → upgrade, authority via bot account.
 * spec-passport-identity-line.md.
 *
 * Proves the whole anonymous→registered line runs on ONE passport mechanism, with authority
 * routed to a PRE-CONFIGURED bot account (not a per-passport permit):
 *   1. device.issue (TOFU, no OTP) → a device-anchor passport routed to bot 'e2e-guest-bot'.
 *   2. verify → a kind:external session whose permit = the bot's services, row-isolated to the
 *      device anchor ($owner). It can call what the bot's permit grants, and ONLY that.
 *   3. upgrade (device → email, OTP-proven) → carries role/bot/meta to the email anchor; the
 *      new session keeps the bot authority + upgradedFrom; the device passport is retired.
 *
 * Harness (setup.js) boots user with:
 *   PASSPORT_ISSUANCE_BYAPP={"e2e-passport":"otp","e2e-device":"device"}
 *   PASSPORT_DEFAULT_BOT_BYAPP={"e2e-device":"e2e-guest-bot"}   PASSPORT_OTP_ECHO=1
 * The bot 'e2e-guest-bot' (its permit) is SEEDED by this suite (write bot-account data).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const APP = 'e2e-device';
const BOT = 'system.e2eguestbot';   // bot uids must start with "system." (bot.js BOT_UID_PREFIX)
const DEVICE = `dev-${process.pid}-${Date.now()}`;          // client-generated device anchor (TOFU)
const EMAIL = `upgraded-${process.pid}@example.com`;        // the anchor it upgrades to
const DENIAL = [-32001, -32003, -32005, -32604];

gate('113 · passport identity-line (device → upgrade, authority via bot account)', () => {
    let redis;
    let deviceId, deviceToken, deviceSession;

    beforeAll(async () => {
        redis = await redisLib.connect();
        // SEED the bot account whose permit the device passport routes to.
        V.assertResult(await rpc('user.bot.create', {
            uid: BOT,
            permit: { allow_all: false, services: { collection: ['collection.payment.record', 'collection.payment.list'] } },
            desc: 'e2e guest authority bot',
        }, ADMIN_TOKEN), 'bot.create');
    }, 30_000);

    afterAll(async () => {
        if (!redis) return;
        for (const a of [DEVICE, EMAIL]) {
            const toks = await redis.sMembers(`USER:SESSIONS:${a}`).catch(() => []);
            for (const t of toks) await redis.del(`session:${t}`);
            await redis.del(`USER:PASSPORT:${a}`, `PASSPORT:SALT:${a}`, `PASSPORT:PROOFS:${a}`,
                `USER:SESSIONS:${a}`, `USER:PASSPORT:OTP:${a}`, `USER:PASSPORT:LOCK:${a}`);
            await redis.sRem('USER:PASSPORT:IDS', a);
        }
        await rpc('user.bot.delete', { uid: BOT }, ADMIN_TOKEN).catch(() => {});
        await redis.quit();
    });

    test('① device.issue (TOFU, no OTP) → device-anchor passport routed to the bot', async () => {
        const r = V.assertResult(await rpc('user.passport.device.issue', { anchor: DEVICE, app: APP, name: 'Guest' }), 'device.issue');
        expect(r.bot).toBe(BOT);
        expect(r.deviceToken).toBeTruthy();
        expect(r.deviceId).toBeTruthy();
        deviceId = r.deviceId; deviceToken = r.deviceToken;
        const ent = JSON.parse(await redis.get(`USER:PASSPORT:${DEVICE}`));
        expect(ent.status).toBe('ACTIVE');
        expect(ent.bot).toBe(BOT);
    }, 30_000);

    test('② verify → external session; permit = the bot’s services, row-isolated to the device anchor', async () => {
        const res = V.assertResult(await rpc('user.passport.verify', { anchor: DEVICE, deviceId, deviceToken }), 'verify');
        expect(res.bot).toBe(BOT);
        deviceSession = res.token;
        const sess = JSON.parse(await redis.get(`session:${deviceSession}`));
        expect(sess.kind).toBe('external');
        expect(sess.permit.services.collection).toContain('collection.payment.record');   // from the bot
        expect(sess.permit.constraints.$owner.value).toBe(DEVICE);                         // row-isolated to anchor
    }, 30_000);

    test('③ the device session reaches what the bot grants, and is denied what it does not', async () => {
        // In the bot's permit → clears checkAccess (may still error on params, never a denial).
        const allowed = await rpc('collection.payment.record', { id: `bogus-${process.pid}` }, deviceSession);
        if (allowed.error) expect(DENIAL).not.toContain(allowed.error.code);
        // NOT in the bot's permit (and storage.asset.upload was narrowed) → denied.
        const denied = await rpc('storage.asset.upload', { file: 'eA==', filename: 'x.txt', mimeType: 'text/plain' }, deviceSession);
        V.assertRpcError(denied, undefined, 'method outside the bot permit must be denied');
        expect(DENIAL).toContain(denied.error.code);
    }, 30_000);

    test('④ upgrade (device → email, OTP-proven) carries the bot authority + upgradedFrom; device retired', async () => {
        // Prove ownership of the new anchor.
        const otp = V.assertResult(await rpc('user.passport.otp.request', { anchor: EMAIL, channel: 'email', app: APP }), 'otp.request');
        const up = V.assertResult(await rpc('user.passport.upgrade', {
            anchor: DEVICE, deviceId, deviceToken, newAnchor: EMAIL, otp: otp.devCode, channel: 'email', name: 'Registered',
        }, ), 'upgrade');
        expect(up.anchor).toBe(EMAIL);
        expect(up.bot).toBe(BOT);
        expect(up.upgradedFrom).toBe(DEVICE);

        // New anchor authenticates → same bot authority, row-isolated to the EMAIL anchor now.
        const sess = V.assertResult(await rpc('user.passport.verify', { anchor: EMAIL, deviceId: up.deviceId, deviceToken: up.deviceToken }), 'verify(email)');
        const stored = JSON.parse(await redis.get(`session:${sess.token}`));
        expect(stored.permit.services.collection).toContain('collection.payment.record');
        expect(stored.permit.constraints.$owner.value).toBe(EMAIL);
        const newEnt = JSON.parse(await redis.get(`USER:PASSPORT:${EMAIL}`));
        expect(newEnt.meta.upgradedFrom).toBe(DEVICE);

        // The device passport is retired → its token no longer authenticates.
        const dead = await rpc('user.passport.verify', { anchor: DEVICE, deviceId, deviceToken });
        V.assertRpcError(dead, -32003, 'retired device passport must not verify');
    }, 30_000);

    test('⑤ fail-closed: device.issue on a non-device app is FORBIDDEN', async () => {
        const closed = await rpc('user.passport.device.issue', { anchor: `x-${process.pid}`, app: 'no-such-app' });
        V.assertRpcError(closed, -32005, 'non-device app → FORBIDDEN');
    }, 30_000);
});
