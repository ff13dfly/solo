#!/usr/bin/env node
/**
 * 200k-row end-to-end evaluation of the Entity Factory's write path.
 *
 * @why docs/feedback/done/entity-factory-no-bulk-write.md measured the serial path at
 *      ~930 rows/s on finance-dev — 21k rows took 22s, past the Router's 10s forward
 *      timeout. This script runs the full import lifecycle at 200k rows (an order of
 *      magnitude past the reported pain point) against a REAL Redis and the REAL factory:
 *      bulk write → read back → re-import (delete + rewrite) → verify → clean up.
 *      It measures the shipped code, not a hand-rolled mock of it.
 *
 * @usage
 *   redis-stack-server --port 6399 --daemonize yes --save ""
 *   REDIS_URL=redis://localhost:6399 node api/bench/entity-bulk-write.bench.js
 *   # options: N=200000 CHUNK=500 SERIAL_SAMPLE=3000
 *
 * Not a jest test on purpose: at this size it is an evaluation with a wall-clock budget,
 * not a pass/fail unit. The hermetic correctness pins live in
 * library/tests/entity-bulk-write.test.js.
 */
const { createClient } = require('redis');
const fs = require('fs');
const { execSync } = require('child_process');
const createEntity = require('../library/entity');
const { createWalArchiver } = require('../library/walarchiver');

const URL = process.env.REDIS_URL || 'redis://localhost:6399';
const N = Number(process.env.N || 200000);
const CHUNK = Number(process.env.CHUNK || 500);
// Serial create() at 200k would take minutes; sample it and extrapolate honestly.
const SERIAL_SAMPLE = Number(process.env.SERIAL_SAMPLE || 3000);
const SERVICE = 'BULKBENCH';
// The WAL archiver runs in every deployed service (bootstrap.js), and it competes for the
// same Redis. Measuring without it overstates throughput — an earlier revision of this
// script did exactly that and reported numbers ~7x optimistic. Default ON; ARCHIVER=off
// isolates the write path when you want that comparison specifically.
const WITH_ARCHIVER = process.env.ARCHIVER !== 'off';
const ROUTER_TIMEOUT_MS = 10000; // api/router/handlers/forward.js:11 (default)

const row = (i) => ({
    subject: `1001-${String(i % 400).padStart(4, '0')}`,
    period: `2026-${String((i % 12) + 1).padStart(2, '0')}`,
    debit: Math.round(i * 13.7) / 100,
    credit: 0,
    memo: `journal line ${i}`,
});

const fmt = (ms) => (Math.abs(ms) >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const rate = (n, ms) => Math.round(n / (ms / 1000)).toLocaleString('en-US');
const pad = (s, w) => String(s).padEnd(w);

async function timed(label, fn) {
    const t = process.hrtime.bigint();
    const out = await fn();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    return { label, ms, out };
}

async function clear(redis) {
    let n = 0;
    const batch = [];
    for await (const k of redis.scanIterator({ MATCH: `${SERVICE}:*`, COUNT: 5000 })) {
        if (Array.isArray(k)) batch.push(...k); else batch.push(k);
        if (batch.length >= 5000) { n += await redis.del(batch.splice(0)); }
    }
    if (batch.length) n += await redis.del(batch);
    return n;
}

(async () => {
    const redis = createClient({ url: URL });
    redis.on('error', (e) => console.error('[redis]', e.message));
    await redis.connect();

    let archiver = null;
    let archiverRedis = null;
    if (WITH_ARCHIVER) {
        archiverRedis = createClient({ url: URL });
        archiverRedis.on('error', () => {});
        await archiverRedis.connect();
        archiver = createWalArchiver(archiverRedis, { consumer: 'bench:1' });
        archiver.start().catch((e) => console.error('[archiver]', e.message));
        await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(`Entity Factory 写入面 e2e 评测 — N=${N.toLocaleString('en-US')} chunk=${CHUNK}`);
    console.log(`Redis: ${URL}   WAL archiver: ${WITH_ARCHIVER ? 'ON（生产形态）' : 'off'}`);
    console.log('='.repeat(72));

    await clear(redis);
    const entity = createEntity(redis, { serviceName: SERVICE, entityName: 'TBAL', idLength: 12 });
    const results = [];

    // ── 0. 回归反馈里那个具体场景 ─────────────────────────────────────────────
    // 21,000 行是 finance 报的真实月度导入量，服务端实测 22.0s、落在 Router 10s 之外
    // （docs/feedback/done/entity-factory-no-bulk-write.md）。整套评测的其余部分是
    // 「能跑多快」，这一节是「那个报上来的 bug 还在不在」——它必须是一个会红的断言，
    // 而不是靠 200k 的数字外推。
    const REPORTED_ROWS = 21000;
    const reportedRows = Array.from({ length: REPORTED_ROWS }, (_, i) => row(i));
    const reported = await timed('reported', async () => {
        const created = await entity.createMany(reportedRows, { chunkSize: CHUNK });
        // 重导 = 删一遍再写一遍，这才是月度导入的真实形态
        await entity.deleteMany(created.items.map((i) => i.id), { chunkSize: CHUNK });
        await entity.createMany(reportedRows, { chunkSize: CHUNK });
    });
    const reportedOk = reported.ms < ROUTER_TIMEOUT_MS;
    console.log(`\n⓪ 回归：反馈实际场景 ${REPORTED_ROWS.toLocaleString('en-US')} 行（原报告单次导入 22.0s，落在 Router 10s 之外）`);
    console.log(`   ${reportedOk ? '✅' : '🔴'} ${fmt(reported.ms)} —— 首次导入 + 一轮重导（删+写），共 3×${REPORTED_ROWS.toLocaleString('en-US')} 行操作`);
    console.log(`      比原报告的单次导入更重，仍余 ${fmt(ROUTER_TIMEOUT_MS - reported.ms)}`);
    const rIdx = await redis.sCard(`${SERVICE}:TBAL:INDEX`);
    console.log(`   ${rIdx === REPORTED_ROWS ? '✅' : '🔴'} 重导后主索引 ${rIdx.toLocaleString('en-US')}（无残留、无重复）`);
    if (!reportedOk) {
        console.error('🔴 回归失败：反馈里的场景仍然超出 Router 转发预算');
        process.exitCode = 1;
    }
    await clear(redis);

    // ── 1. 基线：逐行 create()（抽样外推，200k 全跑要几分钟）────────────────
    const serial = await timed('serial', async () => {
        for (let i = 0; i < SERIAL_SAMPLE; i++) await entity.create(row(i));
    });
    const serialRate = SERIAL_SAMPLE / (serial.ms / 1000);
    const serialProjected = (N / serialRate) * 1000;
    console.log(`\n① 基线 逐行 create()  ${pad(SERIAL_SAMPLE.toLocaleString('en-US') + ' 行', 12)} ${pad(fmt(serial.ms), 9)} ${rate(SERIAL_SAMPLE, serial.ms)} 行/秒`);
    console.log(`   └─ 外推到 ${N.toLocaleString('en-US')} 行：${fmt(serialProjected)}`);
    await clear(redis);

    // ── 2. createMany 全量写入 ────────────────────────────────────────────
    const rows = Array.from({ length: N }, (_, i) => row(i));
    const bulk = await timed('bulk', () => entity.createMany(rows, { chunkSize: CHUNK }));
    console.log(`\n② createMany()       ${pad(N.toLocaleString('en-US') + ' 行', 12)} ${pad(fmt(bulk.ms), 9)} ${rate(N, bulk.ms)} 行/秒`);
    console.log(`   └─ 相对基线提速：${(serialProjected / bulk.ms).toFixed(1)}x`);
    results.push(['写入 createMany', N, bulk.ms]);

    // ── 3. 结构校验：键、索引、游标、抽样内容 ──────────────────────────────
    const [sCard, zCard, sampleRaw] = await Promise.all([
        redis.sCard(`${SERVICE}:TBAL:INDEX`),
        redis.zCard(`${SERVICE}:TBAL:INDEX:CURSOR`),
        redis.get(`${SERVICE}:TBAL:${bulk.out.items[12345].id}`),
    ]);
    const sample = JSON.parse(sampleRaw);
    const idsUnique = new Set(bulk.out.items.map((i) => i.id)).size;
    const ok = (c) => (c ? '✅' : '🔴');
    console.log(`\n③ 结构校验`);
    console.log(`   ${ok(bulk.out.total === N)} 返回条数 ${bulk.out.total.toLocaleString('en-US')} = ${N.toLocaleString('en-US')}`);
    console.log(`   ${ok(idsUnique === N)} id 唯一 ${idsUnique.toLocaleString('en-US')} = ${N.toLocaleString('en-US')}`);
    console.log(`   ${ok(sCard === N)} 主索引 SET  ${sCard.toLocaleString('en-US')}`);
    console.log(`   ${ok(zCard === N)} 游标 ZSET   ${zCard.toLocaleString('en-US')}`);
    console.log(`   ${ok(sample && sample.memo === 'journal line 12345')} 抽样第 12345 行内容正确 (${sample && sample.subject})`);

    // ── 4. 读回：listAll() 走游标分页 ─────────────────────────────────────
    const read = await timed('read', () => entity.listAll({ pageSize: 2000 }));
    console.log(`\n④ listAll() 读回     ${pad(read.out.total.toLocaleString('en-US') + ' 行', 12)} ${pad(fmt(read.ms), 9)} ${rate(read.out.total, read.ms)} 行/秒`);
    console.log(`   ${ok(read.out.total === N)} 读回条数 = 写入条数`);
    results.push(['读回 listAll', read.out.total, read.ms]);

    // ── 5. 重导：整批替换（deleteMany + createMany），导入型的真实形态 ──────
    const ids = bulk.out.items.map((i) => i.id);
    const del = await timed('del', () => entity.deleteMany(ids, { chunkSize: CHUNK }));
    console.log(`\n⑤ deleteMany()       ${pad(del.out.deleted.toLocaleString('en-US') + ' 行', 12)} ${pad(fmt(del.ms), 9)} ${rate(del.out.deleted, del.ms)} 行/秒`);
    results.push(['删除 deleteMany', del.out.deleted, del.ms]);

    const rewrite = await timed('rewrite', () => entity.createMany(rows, { chunkSize: CHUNK }));
    const reimportMs = del.ms + rewrite.ms;
    console.log(`\n⑥ 重导一整轮（删 ${N.toLocaleString('en-US')} + 写 ${N.toLocaleString('en-US')}）  ${fmt(reimportMs)}`);
    const [sCard2, zCard2] = await Promise.all([
        redis.sCard(`${SERVICE}:TBAL:INDEX`), redis.zCard(`${SERVICE}:TBAL:INDEX:CURSOR`),
    ]);
    console.log(`   ${ok(sCard2 === N)} 重导后主索引 ${sCard2.toLocaleString('en-US')}（无残留、无重复）`);
    console.log(`   ${ok(zCard2 === N)} 重导后游标索引 ${zCard2.toLocaleString('en-US')}`);
    results.push(['重导一轮（删+写）', N, reimportMs]);

    // ── 6. Router 10s 超时预算 ───────────────────────────────────────────
    console.log(`\n⑦ Router forward 超时预算（默认 ${ROUTER_TIMEOUT_MS / 1000}s）`);
    const budget = (label, n, ms) => {
        const within = ms < ROUTER_TIMEOUT_MS;
        const maxRows = Math.floor((ROUTER_TIMEOUT_MS / ms) * n);
        console.log(`   ${within ? '✅' : '🔴'} ${pad(label, 20)} ${pad(fmt(ms), 9)} 余量 ${pad(fmt(ROUTER_TIMEOUT_MS - ms), 9)} 该预算内可处理约 ${maxRows.toLocaleString('en-US')} 行`);
    };
    for (const [label, n, ms] of results) budget(label, n, ms);
    console.log(`   ${serialProjected < ROUTER_TIMEOUT_MS ? '✅' : '🔴'} ${pad('（对照）逐行 create', 20)} ${pad(fmt(serialProjected), 9)} 余量 ${fmt(ROUTER_TIMEOUT_MS - serialProjected)}`);

    // ── 8. WAL 审计完整性 + 存储足迹（archiver 打开时才有意义）──────────────
    if (WITH_ARCHIVER) {
        const { WAL } = require('../library/constants');
        console.log(`\n⑧ WAL 审计完整性与存储`);
        // 等归档追平
        const logDir = process.env.LOG_DIR;
        const countRows = () => {
            try {
                return +execSync(`find ${logDir} -name '*.log' -type f -exec cat {} + 2>/dev/null | wc -l`).toString().trim();
            } catch (_) { return -1; }
        };
        if (logDir && fs.existsSync(logDir)) {
            let stable = 0, last = -1;
            const t0 = Date.now();
            while (Date.now() - t0 < 300000) {
                await new Promise((r) => setTimeout(r, 1000));
                const cur = countRows();
                if (cur === last) { if (++stable >= 4) break; } else stable = 0;
                last = cur;
            }
            const rowsOnDisk = countRows();
            const expected = N * 3; // create 200k + delete 200k + re-create 200k
            const files = +execSync(`find ${logDir} -name '*.log' -type f | wc -l`).toString().trim();
            const kb = +execSync(`du -sk ${logDir} | cut -f1`).toString().trim();
            console.log(`   ${rowsOnDisk >= expected ? '✅' : '🔴'} 落盘账本 ${rowsOnDisk.toLocaleString('en-US')} 行 / 应有 ${expected.toLocaleString('en-US')}（写+删+重写）`);
            console.log(`   ${'  '} ${files} 个文件 · ${(kb / 1024).toFixed(1)} MB · 每行 ${Math.round(kb * 1024 / Math.max(rowsOnDisk, 1))} 字节`);
            console.log(`   ${'  '} 归档追平后 WAL:STREAM 剩 ${(await redis.xLen(WAL.STREAM)).toLocaleString('en-US')} 条（MAXLEN 上限 ${WAL.MAXLEN.toLocaleString('en-US')}）`);
        } else {
            console.log(`   ⚠️  未设 LOG_DIR，跳过落盘校验（设 LOG_DIR=<空目录> 可测完整性与存储）`);
        }
    }

    if (archiver) { await archiver.stop().catch(() => {}); await archiverRedis.quit().catch(() => {}); }
    const deleted = await clear(redis);
    console.log(`\n清理：删除 ${deleted.toLocaleString('en-US')} 个键`);
    console.log('='.repeat(72) + '\n');
    await redis.quit();
})().catch((e) => { console.error(e); process.exit(1); });
