/**
 * WAL 只读 reader — §8.3 / §13 决策 3.
 *
 * 从 api/library/logger.js 的 query() **照抄精简**,不跨项目 require、不加 file:../api
 * 依赖,保持 e2e 自包含(Option C)。⚠️ 代价是落盘布局演进必须手动跟进:v1.2.10 的
 * ecef0b7 把归档器落盘换成按天分片后,这里只认旧布局,7 套 ③WAL 断言集体红
 * (症状全是 "found 0 rows",CI 自 2026-08-30 起红)——logger.js 改写盘布局时**必须
 * 同步改这份照抄件**。
 *
 * 两种布局都读(与 logger.js query() 对齐),合并后按 ref 去重、stamp 归并:
 *   ① 按 key(logger.insert(),实体写入路径的旧布局):
 *      key → MD5(key) → {logDir}/{h[0:2]}/{h[2:4]}/{h[4:6]}/{h[6:]}.log
 *   ② 按天分片(logger.insertMany(),v1.2.10+ 归档器唯一落盘路径):
 *      {logDir}/wal/{year}/{YYYY-MM-DD}.log + 同名 .index
 *      index 行 = stamp|op|key|relLogPath|offset —— 5 段才属于本布局(4 段是旧索引),
 *      offset 是**字节**偏移(logger.js 用 Buffer.byteLength 计),读取必须按 Buffer
 *      切片,拿 utf8 字符串下标去切,行里一有中文就错位。
 *      不读 .gz 轮转件:e2e 只查刚写出的行,当天文件绝不轮转(wal-rotate.sh 不碰当天)。
 *   每行一条 JSON:{ op, key, before, after, user, stamp }(entity.js wal())。
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

/** 布局②:扫 {folder}/wal/{year}/*.index 找 key 的行,按字节偏移到当日 .log 里取。 */
function queryDayDir(key, folder, lines = 100) {
    if (!key || !folder) return [];
    const keyString = (typeof key === 'object') ? JSON.stringify(key) : String(key);
    const walRoot = path.join(folder, 'wal');
    if (!fs.existsSync(walRoot)) return [];

    const rows = [];
    const logCache = new Map();   // 每个日志文件一次整读(e2e 查询量小,seek 不值得抄)
    let years;
    try { years = fs.readdirSync(walRoot); } catch { return []; }

    for (const year of years) {
        const yearDir = path.join(walRoot, year);
        let idxFiles;
        try { idxFiles = fs.readdirSync(yearDir).filter((f) => f.endsWith('.index')); } catch { continue; }
        for (const idxFile of idxFiles) {
            let content;
            try { content = fs.readFileSync(path.join(yearDir, idxFile), 'utf8'); } catch { continue; }
            for (const line of content.split('\n')) {
                if (!line) continue;
                const parts = line.split('|');
                if (parts.length < 5 || parts[2] !== keyString) continue;
                const rowPath = path.join(folder, parts[3]);
                let buf = logCache.get(rowPath);
                if (buf === undefined) {
                    try { buf = fs.readFileSync(rowPath); } catch { buf = null; }
                    logCache.set(rowPath, buf);
                }
                const at = parseInt(parts[4], 10);
                if (!buf || !Number.isFinite(at) || at >= buf.length) continue;
                const nl = buf.indexOf(0x0a, at);
                const raw = buf.slice(at, nl === -1 ? buf.length : nl).toString('utf8');
                try { const r = JSON.parse(raw); if (r) rows.push(r); } catch { /* 跳过坏行 */ }
            }
        }
    }
    return rows.slice(-lines);
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
    const rows = [
        ...queryDir(key, primary, lines), ...queryDir(key, DEV_LOG_DIR, lines),
        ...queryDayDir(key, primary, lines), ...queryDayDir(key, DEV_LOG_DIR, lines),
    ];
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
