/**
 * 安全断言 —— 模糊测试后核对"接口是否安全"的不变量。
 * 核心:不崩(服务还活)、不擦库(canary 还在)、不污染原型(鉴权没被绕)。
 */
const http = require('http');
const assert = require('assert');
const { read } = require('./context');

// 直连服务 /auth/seed 判存活(服务都在 init 后才 listen,200 = 活着没崩).
function svcAlive(svcName) {
    const port = read().services?.[svcName];
    return new Promise((resolve) => {
        if (!port) return resolve(false);
        const req = http.get(`http://localhost:${port}/auth/seed`, { timeout: 2500 }, (r) => {
            r.resume();
            resolve(r.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function assertAlive(svcName) {
    assert.ok(await svcAlive(svcName), `[SECURITY] service "${svcName}" not responding after attack — crashed / DoS'd?`);
}

// canary 还在 = 没有 FLUSHALL/擦库(Redis 命令注入若得逞会删掉它).
async function assertCanary(redis, key) {
    assert.strictEqual(await redis.get(key), 'alive', `[SECURITY] canary ${key} gone — Redis may have been wiped (command injection?)`);
}

// 本测试进程的 Object.prototype 没被污染(防御性;跨进程污染靠 §鉴权行为 canary 检).
function assertNoProtoPollution() {
    const o = {};
    for (const k of ['e2ePolluted', 'e2ePolluted2', 'allow_all', 'isAdmin', 'polluted']) {
        assert.strictEqual(o[k], undefined, `[SECURITY] Object.prototype polluted with "${k}"`);
    }
}

module.exports = { svcAlive, assertAlive, assertCanary, assertNoProtoPollution };
