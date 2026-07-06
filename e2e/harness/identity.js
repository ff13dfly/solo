/**
 * 身份 helpers(§4/§5).
 *   createAndLogin — 真实挑战-响应登录(register → login.request → login.verify),拿真 session token.
 *   setPermit      — permit 杠杆:直写 user:{uid}.permit(Router 鉴权走 Scheme F 实时读它,§5).
 *   ADMIN_TOKEN    — globalSetup 注入的 allow_all 管理会话(管理操作用,不需"真实登录").
 */
const crypto = require('crypto');
const { rpc } = require('../lib/client');
const { sha256 } = require('../lib/crypto');

const ADMIN_TOKEN = 'e2e-harness-admin';

/**
 * 建一个能真实登录的测试用户,返回 { uid, token, name, password }.
 * 自带 salt+hash(不传则服务端随机生成 → 永远登不上,user.js:31).
 */
async function createAndLogin({ name, password = 'e2e-pass', deviceId = 'e2e' }) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = sha256(password + salt);                       // = 服务端将存的 user.hash

    const reg = await rpc('user.register', { name, salt, hash });
    if (reg.error) throw new Error(`user.register failed for "${name}": [${reg.error.code}] ${reg.error.message}`);

    const req = await rpc('user.login.request', { name });
    if (req.error) throw new Error(`user.login.request failed: ${req.error.message}`);
    const challenge = req.result.challenge;                     // 120s 一次性

    const response = sha256(challenge + hash);
    const ver = await rpc('user.login.verify', { name, challenge, response, deviceId });
    if (ver.error) throw new Error(`user.login.verify failed: ${ver.error.message}`);

    return { uid: ver.result.uid, token: ver.result.token, categories: ver.result.categories, name, password };
}

/**
 * Re-login an already-registered user (challenge-response only, no re-register).
 * Returns the full login.verify result (incl. `categories` — the tier axis portals gate on).
 * Mirrors createAndLogin's plain sha256(password+salt) scheme; salt comes from login.request.
 */
async function loginOnly({ name, password = 'e2e-pass', deviceId = 'e2e' }) {
    const req = await rpc('user.login.request', { name });
    if (req.error) throw new Error(`user.login.request failed: ${req.error.message}`);
    const { challenge, salt } = req.result;
    const hash = sha256(password + salt);
    const response = sha256(challenge + hash);
    const ver = await rpc('user.login.verify', { name, challenge, response, deviceId });
    if (ver.error) throw new Error(`user.login.verify failed: ${ver.error.message}`);
    return ver.result;
}

/** permit 杠杆:直接改 user:{uid}.permit(H6 与 Router checkAccess 都读这里). */
async function setPermit(redis, uid, permit) {
    const raw = await redis.get(`user:${uid}`);
    if (!raw) throw new Error(`setPermit: user:${uid} not found`);
    const u = JSON.parse(raw);
    u.permit = permit;
    await redis.set(`user:${uid}`, JSON.stringify(u));
}

/** 便捷:建测试用户 + 真实登录 + (可选)按服务授权。返回 { uid, token, name }. */
async function sessionUser(redis, name, permitServices = {}) {
    const u = await createAndLogin({ name });
    if (Object.keys(permitServices).length) {
        await setPermit(redis, u.uid, { allow_all: false, services: permitServices });
    }
    return u;
}

/** 清理测试用户(data + name 索引 + ids set). */
async function cleanupUser(redis, { uid, name }) {
    if (uid) { await redis.del(`user:${uid}`); await redis.sRem('user:ids', uid); }
    if (name) await redis.del(`user:name:${name.toLowerCase().trim()}`);
}

module.exports = { ADMIN_TOKEN, createAndLogin, loginOnly, setPermit, sessionUser, cleanupUser };
