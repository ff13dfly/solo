/**
 * jest globalTeardown — 反序杀掉 setup.js 起的进程,清 harness 自造的 key.
 * 'external' 哨兵的不杀(别人起的). Redis 若是我们起的,用 SHUTDOWN NOSAVE 协议关停
 * (redis-stack-server 是 wrapper,SIGTERM 它的 pid 杀不掉真正在 6699 上的 redis-server 子进程).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('redis');

const { ADMIN_TOKEN } = require('./identity');
const ctxFile = require('../lib/context');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6699';
const PID_FILE = path.join(os.tmpdir(), 'solo-e2e-pids.json');

function killPid(label, pid) {
    if (!pid || pid === 'external') return;
    const n = parseInt(pid, 10);
    if (!n || isNaN(n)) return;
    try { process.kill(n, 'SIGTERM'); console.log(`[E2E teardown] ${label} (pid ${n}) stopped.`); }
    catch (e) { if (e.code !== 'ESRCH') console.warn(`[E2E teardown] stop ${label}: ${e.message}`); }
}

module.exports = async function globalTeardown() {
    let pids = { redis: null, services: {} };
    try { pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { /* setup may have failed early */ }

    // 反序杀服务(Router 最后).
    for (const [name, pid] of Object.entries(pids.services || {}).reverse()) killPid(name, pid);

    const weStartedRedis = pids.redis && pids.redis !== 'external';

    // 清 admin 会话;若 redis 是我们起的,SHUTDOWN NOSAVE 协议关停(可靠杀掉 redis-stack 子进程).
    const redis = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1500 } });
    redis.on('error', () => {});
    try {
        await redis.connect();
        await redis.del(`session:${ADMIN_TOKEN}`);
        await redis.del('SYSTEM:CONFIG:EVENT_REGISTRY'); // full profile 写的覆盖,清掉免污染 dev 栈
        if (weStartedRedis) {
            try { await redis.sendCommand(['SHUTDOWN', 'NOSAVE']); } catch { /* 连接随关停断开,预期 */ }
            console.log(`[E2E teardown] redis shut down (was started by harness).`);
        }
    } catch { /* redis 可能已不可达 */ }
    finally { await redis.quit().catch(() => {}); }

    // 兜底:SIGTERM 记录的 wrapper pid.
    if (weStartedRedis) killPid('redis-wrapper', pids.redis);

    for (const f of [PID_FILE, ctxFile.CONTEXT_FILE]) { try { fs.unlinkSync(f); } catch {} }
};
