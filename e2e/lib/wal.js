/**
 * WAL 只读 reader — §8.3 / §13 决策 3.
 *
 * 从 api/library/logger.js 的 query() **照抄精简**(MD5 三级路径 + 解析 jsonl),
 * 不跨项目 require、不加 file:../api 依赖,保持 e2e 自包含(Option C).
 *
 * 路径方案(与 logger.js 一致):
 *   key → MD5(key) → {logDir}/{h[0:2]}/{h[2:4]}/{h[4:6]}/{h[6:]}.log
 *   每行一条 JSON:{ op, key, before, after, user, stamp }(entity.js wal()).
 *   传 **data key**(SERVICE:ENTITY:{id}),不是裸 id;传错 → 返回 []。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { read } = require('./context');

function queryDir(key, folder, lines = 100) {
    if (!key || !folder) return [];

    const keyString = (typeof key === 'object') ? JSON.stringify(key) : String(key);
    const hash = crypto.createHash('md5').update(keyString).digest('hex');
    const filePath = path.join(
        folder,
        hash.substring(0, 2),
        hash.substring(2, 4),
        hash.substring(4, 6),
        `${hash.substring(6)}.log`,
    );

    if (!fs.existsSync(filePath)) return [];
    try {
        return fs.readFileSync(filePath, 'utf8')
            .trim()
            .split('\n')
            .slice(-lines)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch { return []; }
}

// 文件 WAL 自 2026-06-10 起由 walarchiver(消费组)落盘:dev 长跑进程与 e2e 拉起的
// 服务共享同一个 Redis + 消费组,但 LOG_DIR 不同 → 同一 key 的行可能分摊在 harness
// 的 tmp logDir 和仓库的 api/logs 两处(多消费者分工的本地化体现)。查询时合并两个
// 目录,按 ref(流条目 id)去重、按 stamp 排序 —— 与归档器 at-least-once 语义一致。
// 注意:logger.js 的 DEFAULT_LOG_DIR = api/library/../../logs = 仓库根 logs/
// (其源码注释写 "api/logs" 是错的 —— 以实测落点为准)。
const DEV_LOG_DIR = path.resolve(__dirname, '../../logs');

function query(key, logDir, lines = 100) {
    const primary = logDir || read().logDir;
    const rows = [...queryDir(key, primary, lines), ...queryDir(key, DEV_LOG_DIR, lines)];
    const seen = new Set();
    return rows
        .filter((r) => {
            const id = r.ref || `${r.op}:${r.stamp}`;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .sort((a, b) => (a.stamp || 0) - (b.stamp || 0));
}

module.exports = { query };
