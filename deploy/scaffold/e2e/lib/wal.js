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

function query(key, logDir, lines = 100) {
    const folder = logDir || read().logDir;
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

module.exports = { query };
