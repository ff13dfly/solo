/**
 * 场景: Storage 并发上传 sha256 完整性测试
 *
 * 复现 issue_20260425 的竞态条件：
 *   N 个任务同时调用 storage.asset.upload，并发量超过 Worker poolSize(4)，
 *   Worker 池若缺少 taskId 关联则会错发 sha256 结果，导致跨用户数据漂移。
 *
 * 测试策略：
 *   1. 为每个上传任务生成唯一内容的 buffer
 *   2. 本地预计算每个 buffer 的 sha256（先算）
 *   3. 并发执行所有上传（Promise.all）
 *   4. 从 Redis 直接读取落库 metadata（不信任响应体）
 *   5. 比对实际 sha256 与预期值（后比）
 *   6. 任何不匹配 → 报告漂移
 *
 * 并发梯度测试（poolSize 之下和之上）：
 *   - concurrency=2：低并发，正常情况下不触发
 *   - concurrency=8：超过 poolSize(4)，竞态高发区
 *   - concurrency=20：压力测试
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const { buildUploadTasks, verifyUploads, printVerifyReport } = require('../../framework/precompute');

// storage config（测试专用：指向测试 Redis + 临时 uploadDir）
function makeStorageConfig(redis, uploadDir, endpoint) {
    const baseConfig = require(path.join(__dirname, '../../../../apps/storage/config'));
    return {
        ...baseConfig,
        uploadDir,
        redis: {
            ...baseConfig.redis,
            // 使用与 framework/redis.js 相同的 DB 15 连接
        },
        thumbnails: { enabled: false },  // 测试不生成缩略图，减少副作用
        // 指向本场景内启动的 local-oss-server（provider=local），字节走 OSS 路径
        storage: {
            ...(baseConfig.storage || {}),
            provider: 'local',
            access: 'public',
            thumbnails: { mode: 'off' },
            local: { endpoint, bucket: 'solo', secret: 'sim-secret' },
        },
        bodyLimit: '50mb',
    };
}

async function runConcurrentUpload(redis, concurrency, label) {
    // 临时目录（每次测试独立）
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-test-storage-'));

    // 启动进程内 local-oss-server（root=uploadDir，零拷贝），让 upload 走真实 OSS 路径
    const { createLocalOssServer } = require(path.join(__dirname, '../../../../apps/storage/oss'));
    const ossServer = createLocalOssServer({ root: uploadDir, secret: 'sim-secret', bucket: 'solo', publicRead: true });
    const ossPort = await ossServer.listen(0);

    try {
        const storageLogic = require(path.join(__dirname, '../../../../apps/storage/logic'));
        const config = makeStorageConfig(redis, uploadDir, `http://localhost:${ossPort}`);
        const logic = storageLogic(redis, { config });

        // 1. 预计算所有任务的期望 sha256
        const tasks = buildUploadTasks(concurrency, 8192);

        console.log(`[${label}] Concurrency=${concurrency}, uploading...`);
        const start = Date.now();

        // 2. 并发执行上传（直接调用 logic 层，无 HTTP）
        const responses = await Promise.all(
            tasks.map(t =>
                logic.asset.upload({
                    file:     t.base64,
                    filename: `test_${t.index}.bin`,
                    mimeType: 'application/octet-stream',
                }).catch(err => ({ error: err.message || String(err) }))
            )
        );

        const elapsed = Date.now() - start;
        console.log(`[${label}] Done in ${elapsed}ms`);

        // 3. 从 Redis 核对（先算后比）
        const report = await verifyUploads(
            redis,
            tasks,
            responses,
            'STORAGE:ASSET:'
        );

        return printVerifyReport(label, report);

    } finally {
        // 关闭 OSS 服务器并清理临时文件
        await ossServer.close();
        fs.rmSync(uploadDir, { recursive: true, force: true });
    }
}

async function run(redis) {
    console.log('\n═══ Storage Concurrent Upload Test ═══\n');

    const results = [];

    // 梯度测试：低并发 → 超过 poolSize → 压力
    for (const [n, label] of [
        [2,  'Below poolSize (2)'],
        [6,  'Above poolSize (6)'],
        [16, 'Stress (16)'],
    ]) {
        const ok = await runConcurrentUpload(redis, n, label);
        results.push({ label, n, ok });
    }

    // 汇总
    console.log('═══ Summary ═══');
    results.forEach(r => {
        const icon = r.ok ? '✅' : '❌';
        console.log(`  ${icon} ${r.label} (n=${r.n})`);
    });
    console.log('');

    return results.every(r => r.ok);
}

module.exports = { run };
