/**
 * library/auth.js — Z-Handshake (handleSeed / handleVerify) 单测.
 *
 * 此前握手路径零单测覆盖.建立守护,并锁住 M3(删 ACTIVE_SESSIONS 死状态)后行为不变:
 *   ① handleSeed 发出唯一 seed
 *   ② handleVerify 接受对该 seed 的合法 Ed25519 签名(删 session 后握手照常成功)
 *   ③ 对未发出的 seed 的签名被拒(seed 必须由本服务发出)
 *   ④ seed 单次性:验证成功后即消费,重放同一签名被拒(PENDING_SEEDS.delete 仍生效)
 *   ⑤ 缺参 → 400
 */
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { createAuthHandlers } = require('../auth');

const ROUTER_PK = '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji';

function mockRes() {
    const r = { _status: 200, _json: null };
    r.status = (c) => { r._status = c; return r; };
    r.json = (o) => { r._json = o; return r; };
    return r;
}

// 用一对真实 Ed25519 密钥对一段 seed 字符串签名(镜像 router/handlers/service.js)。
function signSeed(seed, kp) {
    const message = new TextEncoder().encode(seed);
    return {
        signature: bs58.encode(tweetnacl.sign.detached(message, kp.secretKey)),
        publicKey: bs58.encode(kp.publicKey),
    };
}

describe('auth Z-handshake — handleSeed / handleVerify', () => {
    const { handleSeed, handleVerify } = createAuthHandlers({ serviceName: 'test', routerPublicKey: ROUTER_PK });
    const issueSeed = () => { const res = mockRes(); handleSeed({}, res); return res._json.seed; };

    test('handleSeed 发出非空、每次不同的 seed', () => {
        const a = issueSeed();
        const b = issueSeed();
        expect(typeof a).toBe('string');
        expect(a.length).toBeGreaterThan(0);
        expect(a).not.toBe(b);
    });

    test('合法签名 → 握手成功(删 ACTIVE_SESSIONS 后仍工作)', () => {
        const seed = issueSeed();
        const kp = tweetnacl.sign.keyPair();
        const res = mockRes();
        handleVerify({ body: signSeed(seed, kp) }, res, 'test', '1.0.0', 123);
        expect(res._json).toMatchObject({ success: true, serviceName: 'test', version: '1.0.0', startupTime: 123 });
    });

    test('对未发出的 seed 的签名 → 拒绝(401)', () => {
        const kp = tweetnacl.sign.keyPair();
        const res = mockRes();
        // 没经过 handleSeed 的随机 seed —— 不在 PENDING_SEEDS 里
        handleVerify({ body: signSeed('a'.repeat(64), kp) }, res, 'test', '1.0.0', 1);
        expect(res._status).toBe(401);
        expect(res._json.success).toBe(false);
    });

    test('seed 单次性:成功后重放同一签名 → 拒绝', () => {
        const seed = issueSeed();
        const kp = tweetnacl.sign.keyPair();
        const sig = signSeed(seed, kp);
        const ok = mockRes();
        handleVerify({ body: sig }, ok, 'test', '1.0.0', 1);
        expect(ok._json.success).toBe(true);
        const replay = mockRes();
        handleVerify({ body: sig }, replay, 'test', '1.0.0', 1);   // seed 已被消费
        expect(replay._status).toBe(401);
    });

    test('缺 signature/publicKey → 400', () => {
        const res = mockRes();
        handleVerify({ body: {} }, res, 'test', '1.0.0', 1);
        expect(res._status).toBe(400);
    });
});
