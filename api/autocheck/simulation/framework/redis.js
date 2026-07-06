/**
 * Test Redis — 隔离测试库
 *
 * 使用 DB 15（与生产 DB 0 完全隔离），每次测试套件开始前 FLUSHDB。
 * 测试结束后调用 teardown() 清理并断开连接。
 */

const { createClient } = require('redis');

// DB 15 作为测试专用库，绝不与生产 DB 0 混用
// Default matches deploy/dev.sh (port 6699). Override with TEST_REDIS_URL env var.
const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6699/15';

let client = null;

async function setup() {
    client = createClient({ url: TEST_REDIS_URL });
    client.on('error', err => console.error('[TestRedis] Error:', err.message));
    await client.connect();
    // 清空测试库，保证每次从干净状态开始
    await client.flushDb();
    console.log(`[TestRedis] Connected to ${TEST_REDIS_URL}, DB flushed`);
    return client;
}

async function teardown() {
    if (client) {
        await client.flushDb();
        await client.quit();
        client = null;
        console.log('[TestRedis] Disconnected');
    }
}

function get() {
    if (!client) throw new Error('TestRedis not initialized. Call setup() first.');
    return client;
}

module.exports = { setup, teardown, get };
