/**
 * 预计算与核对工具
 *
 * 核心模式：
 *   1. 请求前计算预期值（sha256、内容 hash、业务规则等）
 *   2. 请求执行（单个或并发）
 *   3. 从 Redis 直接读取已落库记录
 *   4. 比对实际值与预期值，报告所有异常
 *
 * 这种"先算后比"的方式能在不依赖响应体的情况下发现数据漂移。
 */

const crypto = require('crypto');

/**
 * 生成唯一测试文件内容（模拟不同用户上传不同图片）
 * @param {number} index   用于区分文件的索引
 * @param {number} size    文件字节数，默认 4KB
 */
function makeUniqueBuffer(index, size = 4096) {
    const buf = Buffer.alloc(size);
    // 前 4 字节写入 index，确保每个文件内容唯一
    buf.writeUInt32BE(index, 0);
    // 其余填随机数（固定 seed 保证可复现）
    crypto.createHash('sha256').update(String(index)).digest().copy(buf, 4);
    return buf;
}

/**
 * 本地计算 buffer 的 sha256（与 storage worker 使用同一算法）
 */
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 构建一批预计算任务
 * @param {number} n       任务数量
 * @param {number} size    每个 buffer 的大小
 * @returns {Array} [{ index, buffer, base64, expectedSha256 }, ...]
 */
function buildUploadTasks(n, size = 4096) {
    return Array.from({ length: n }, (_, i) => {
        const buffer = makeUniqueBuffer(i, size);
        return {
            index: i,
            buffer,
            base64: buffer.toString('base64'),
            expectedSha256: sha256(buffer),
        };
    });
}

/**
 * 核对结果：比较响应中的 assetId 对应的 Redis 记录 sha256 与预期值
 *
 * @param {object} redis       测试 Redis client
 * @param {Array}  tasks       buildUploadTasks 返回的任务数组
 * @param {Array}  responses   upload 响应数组，每项含 { id }
 * @param {string} assetPrefix Redis key 前缀，默认 'STORAGE:ASSET:'
 * @returns {object} { passed, drifts }
 */
async function verifyUploads(redis, tasks, responses, assetPrefix = 'STORAGE:ASSET:') {
    const drifts = [];
    const passed = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const res  = responses[i];

        if (!res || res.error) {
            drifts.push({
                index: i,
                type: 'REQUEST_FAILED',
                error: res?.error || 'no response',
            });
            continue;
        }

        // 从 Redis 直接读取已落库的 metadata（不信任 HTTP 响应体）
        const raw = await redis.get(`${assetPrefix}${res.id}`);
        if (!raw) {
            drifts.push({ index: i, assetId: res.id, type: 'NOT_IN_REDIS' });
            continue;
        }

        let meta;
        try {
            meta = JSON.parse(raw);
        } catch (e) {
            drifts.push({ index: i, assetId: res.id, type: 'PARSE_ERROR' });
            continue;
        }

        if (meta.sha256 !== task.expectedSha256) {
            drifts.push({
                index:    i,
                assetId:  res.id,
                type:     'SHA256_DRIFT',
                expected: task.expectedSha256,
                actual:   meta.sha256,
                // 找出实际 sha256 对应的 task（漂移到谁身上）
                driftedFrom: tasks.find(t => t.expectedSha256 === meta.sha256)?.index ?? 'unknown',
            });
        } else {
            passed.push({ index: i, assetId: res.id, sha256: meta.sha256 });
        }
    }

    return { passed, drifts };
}

/**
 * 打印核对报告
 */
function printVerifyReport(label, { passed, drifts }) {
    const total = passed.length + drifts.length;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`[Verify] ${label}`);
    console.log(`  Total: ${total}  Passed: ${passed.length}  Drifts: ${drifts.length}`);
    if (drifts.length > 0) {
        console.log(`\n  ❌ Drifts:`);
        drifts.forEach(d => {
            if (d.type === 'SHA256_DRIFT') {
                console.log(`    Task[${d.index}] asset:${d.assetId}`);
                console.log(`      expected: ${d.expected.slice(0, 16)}...`);
                console.log(`      actual:   ${d.actual.slice(0, 16)}... (drifted from task[${d.driftedFrom}])`);
            } else {
                console.log(`    Task[${d.index}] ${d.type}`, d.error || '');
            }
        });
    } else {
        console.log(`  ✅ All sha256 values match expected`);
    }
    console.log(`${'─'.repeat(50)}\n`);
    return drifts.length === 0;
}

module.exports = { makeUniqueBuffer, sha256, buildUploadTasks, verifyUploads, printVerifyReport };
