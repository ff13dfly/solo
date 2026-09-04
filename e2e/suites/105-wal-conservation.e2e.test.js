/**
 * 105 · WAL / 索引守恒（量 + 时间）—— 写进去多少，账本与索引就必须有多少。
 *
 * 为什么有这套（2026-09-04）：v1.2.8→v1.2.12 十一处修复里四处是「资源生命周期」类、全部静默——
 *   · WAL 归档丢行（2 万行只落盘 18806 行，XADD MAXLEN 修剪掉了消费组还没读的条目，无报错）
 *   · reclaim 过冲把热流削成几秒的中继队列，nexus.trace.byTrace 读不到 WAL 行
 *   · destroy() 只 sRem 主索引、不 zRem 游标 ZSET，ZSET 无限长
 *   · CAS 引用计数并发窗口
 *   它们共同的形状是「单次调用全对、累计起来不守恒」，现有套件按单次调用断言，看不见。
 *   98 号套件钉的是单条账本行的原子性；本套钉的是 **N 条之后的守恒**。
 *
 * 链路：collection.payment.record ×N（经 Router 真实转发，有界并发）
 *      → 实体 create（SET + INDEX SET + CURSOR ZSET + WAL:STREAM 同一 MULTI）
 *      → collection 进程内 archiver 消费 WAL:STREAM → LOG_DIR/wal/{year}/{date}.log
 *
 * 守恒断言：
 *   ① N 次 RPC 全部成功、N 个互异 id；
 *   ② 主索引 SET 与游标 ZSET 各恰好增长 N，每个 id 两处都在（_listByCursor 的前提：zCard ≥ sCard）；
 *   ③ 热流里 N 条 create 账本行一条不少 —— N 远小于保留窗口（WAL_STREAM_KEEP 默认 = MAXLEN 10000），
 *      少一条就是 reclaim 过冲（v1.2.10 那个 bug 在这里现形）；XLEN 有上界（MAXLEN ~ 修剪确实在生效）；
 *   ④ 归档追平：消费组 pending → 0，磁盘上恰好 N 行 create（按 ref = 流条目 id 去重，且与流里的 id 集相等）
 *      —— 少了是丢行，多了是重复归档；
 *   ⑤ 全程各服务 ERROR:QUEUE 零增量。
 *
 * lite profile 即可（user + collection）。N 用 E2E_WAL_N 覆盖（默认 400：约 20 批 × 20 并发，几秒内写完，
 * 归档追平通常 < 5s；再大只会更慢，不会更严）。
 */
const fs = require('fs');
const path = require('path');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { read: readContext } = require('../lib/context');
const { ADMIN_TOKEN } = require('../harness/identity');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N      = Number(process.env.E2E_WAL_N || 400);
const BATCH  = 20;                          // 同时在飞的 RPC 数（Router 有界，别当压测）
const STREAM = 'WAL:STREAM';                // library/constants.js WAL.STREAM
const GROUP  = 'wal-archiver';              // library/constants.js WAL.GROUP
const MAXLEN = Number(process.env.WAL_STREAM_MAXLEN || 10000);
const PREFIX = 'COLLECTION:PAYMENT:';
const IDX    = 'COLLECTION:PAYMENT:INDEX';
const CUR    = 'COLLECTION:PAYMENT:INDEX:CURSOR';
const TAG    = `wal105-${process.pid}`;

describe('105 · WAL conservation under volume (N rows → N ledger rows, N index entries, N archived)', () => {
    let redis;
    const ids = [];
    const idSet = new Set();
    let baseIdx = 0;
    let baseCur = 0;
    const streamRefs = new Set();             // 流条目 id（= 归档行的 ref）

    beforeAll(async () => {
        redis = await redisLib.connect();
        baseIdx = await redis.sCard(IDX);
        baseCur = await redis.zCard(CUR);
    });

    afterAll(async () => {
        if (!redis) return;
        // 与 40-concurrency 同款清理，但连游标 ZSET 一起退场（否则 zCard > sCard 的残留
        // 会给后续套件的守恒基线添噪音）。
        for (let i = 0; i < ids.length; i += 200) {
            const m = redis.multi();
            for (const id of ids.slice(i, i + 200)) { m.del(`${PREFIX}${id}`); m.sRem(IDX, id); m.zRem(CUR, id); }
            await m.exec();
        }
        await redis.quit().catch(() => {});
    });

    test(`1. ${N} records in batches of ${BATCH} — every RPC succeeds, ids distinct`, async () => {
        for (let i = 0; i < N; i += BATCH) {
            const n = Math.min(BATCH, N - i);
            const results = await Promise.all(Array.from({ length: n }, (_, j) =>
                rpc('collection.payment.record', { amount: 1 + i + j, currency: 'CNY', orderId: `${TAG}-${i + j}`, source: 'e2e-105' }, ADMIN_TOKEN)));
            results.forEach((r, j) => { ids.push(V.assertResult(r, `payment.record #${i + j}`).id); });
        }
        ids.forEach((id) => idSet.add(id));
        expect(ids).toHaveLength(N);
        expect(idSet.size).toBe(N);
    }, 120_000);

    test('2. index conservation — SET and cursor ZSET each grew by exactly N; every id in both', async () => {
        expect(await redis.sCard(IDX) - baseIdx).toBe(N);
        expect(await redis.zCard(CUR) - baseCur).toBe(N);
        let missingSet = 0, missingZset = 0;
        for (let i = 0; i < ids.length; i += 100) {
            const m = redis.multi();
            for (const id of ids.slice(i, i + 100)) { m.sIsMember(IDX, id); m.zScore(CUR, id); }
            const out = await m.exec();
            for (let k = 0; k < out.length; k += 2) {
                if (!out[k]) missingSet++;
                if (out[k + 1] === null || out[k + 1] === undefined) missingZset++;
            }
        }
        expect(missingSet).toBe(0);
        expect(missingZset).toBe(0);
    });

    test('3. hot stream keeps all N create rows (retention window not over-trimmed) and stays bounded', async () => {
        const entries = await redis.xRange(STREAM, '-', '+');
        const ours = entries.filter(({ message }) =>
            message.op === 'create' && typeof message.key === 'string' && message.key.startsWith(PREFIX) && idSet.has(message.key.slice(PREFIX.length)));
        ours.forEach(({ id }) => streamRefs.add(id));
        // N ≪ WAL_STREAM_KEEP（默认 = MAXLEN）：追平后 reclaim 只许削「比保留窗口更老」的条目，
        // 我们刚写的 N 条必须一条不少。v1.2.10 的 reclaim 过冲会让这里少行。
        expect(ours).toHaveLength(N);
        expect(streamRefs.size).toBe(N);
        // MAXLEN ~ 是近似修剪，实际长度可略超阈值；这里只钉「修剪在生效」，不钉精确值。
        const len = await redis.xLen(STREAM);
        expect(len).toBeLessThanOrEqual(MAXLEN + 2000);
    });

    test('4. archiver catches up — pending 0, exactly N create rows on disk, ref set == stream set', async () => {
        const logDir = readContext().logDir;
        expect(typeof logDir).toBe('string');

        // 磁盘上属于我们的 create 行，按 ref 去重（at-least-once 消费下 ref 是唯一的重复检测器）
        const diskRefs = () => {
            const refs = new Set();
            let rows = 0;
            const walRoot = path.join(logDir, 'wal');
            if (!fs.existsSync(walRoot)) return { refs, rows };
            for (const year of fs.readdirSync(walRoot)) {
                const dir = path.join(walRoot, year);
                if (!fs.statSync(dir).isDirectory()) continue;
                for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.log'))) {
                    const text = fs.readFileSync(path.join(dir, f), 'utf8');
                    for (const line of text.split('\n')) {
                        if (!line) continue;
                        let row; try { row = JSON.parse(line); } catch { continue; }
                        if (row.op !== 'create' || typeof row.key !== 'string' || !row.key.startsWith(PREFIX)) continue;
                        if (!idSet.has(row.key.slice(PREFIX.length))) continue;
                        rows++;
                        refs.add(row.ref);
                    }
                }
            }
            return { refs, rows };
        };

        // 追平判据：我们的 N 条全部落盘 且 消费组无 pending。归档是异步副本，轮询 ≤ 60s。
        let pending = -1, disk = { refs: new Set(), rows: 0 };
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            disk = diskRefs();
            const p = await redis.xPending(STREAM, GROUP).catch(() => null);
            pending = p ? Number(p.pending) : -1;
            if (disk.refs.size >= N && pending === 0) break;
            await sleep(250);
        }
        expect(pending).toBe(0);                 // 交付出去的都 ack 了 ⇒ 都写进文件了
        expect(disk.rows).toBe(N);               // 少 = 丢行；多 = 重复归档
        expect(disk.refs.size).toBe(N);
        expect([...disk.refs].sort()).toEqual([...streamRefs].sort());   // 文件行 ↔ 流条目一一对应

        // Redis 7 的 XINFO GROUPS 带 lag：追平后应为 0（老版本没有该字段则跳过）
        const groups = await redis.xInfoGroups(STREAM).catch(() => []);
        const g = groups.find((x) => x.name === GROUP);
        expect(g).toBeDefined();
        const lag = g.lag ?? g['lag'];
        if (lag !== undefined && lag !== null) expect(Number(lag)).toBe(0);
    }, 90_000);

    test('5. no service queued an error during the burst', async () => {
        await V.assertNoErrors(redis);
    });
});
