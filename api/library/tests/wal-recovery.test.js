#!/usr/bin/env node
/**
 * WAL Disaster Recovery Integration Test
 *
 * This test verifies the full WAL recovery pipeline:
 * 1. Create entities via Entity Factory (generates WAL logs)
 * 2. Take a simulated snapshot
 * 3. Do more writes (create/update/delete)
 * 4. Simulate disaster: delete the post-snapshot data from Redis
 * 5. Recover using WAL replay
 * 6. Verify recovered data matches expected state
 *
 * Usage: node wal-recovery.test.js [redisUrl]
 * Default Redis: redis://localhost:6379
 *
 * WARNING: Uses a TEST_ prefixed namespace to avoid touching real data.
 */

const path = require('path');
const fs = require('fs');
const { createClient } = require('redis');

// Use a dedicated test log directory to avoid polluting real logs
const TEST_LOG_DIR = path.join(__dirname, '../../../logs/__test_wal__');
process.env.LOG_DIR = TEST_LOG_DIR;

// Must set LOG_DIR before requiring logger/entity (module-level init)
const createEntity = require('../entity');
const { walContext } = require('../entity');
const logger = require('../logger');

const REDIS_URL = process.argv[2] || process.env.REDIS_URL || 'redis://localhost:6379';

// --- Test Helpers ---

function cleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function assert(condition, msg) {
    if (!condition) {
        console.error(`  ❌ FAIL: ${msg}`);
        process.exitCode = 1;
        return false;
    }
    console.log(`  ✅ PASS: ${msg}`);
    return true;
}

/**
 * Inline recovery logic (same as deploy/wal-recover.js but returns stats)
 */
async function recoverAfter(redis, afterStamp, logDir) {
    const walIndexDir = path.join(logDir, 'wal');
    const entries = [];

    if (!fs.existsSync(walIndexDir)) return { replayed: 0 };

    const years = fs.readdirSync(walIndexDir).filter(f =>
        fs.statSync(path.join(walIndexDir, f)).isDirectory()
    );

    for (const year of years) {
        const yearDir = path.join(walIndexDir, year);
        const indexFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.index')).sort();

        for (const indexFile of indexFiles) {
            const content = fs.readFileSync(path.join(yearDir, indexFile), 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);

            for (const line of lines) {
                const [stampStr, op, key, logFile] = line.split('|');
                const stamp = parseInt(stampStr);
                if (stamp > afterStamp && op !== 'snapshot') {
                    entries.push({ stamp, op, key, logFile });
                }
            }
        }
    }

    // Replay strictly by stamp: with the stream→archiver design, multiple archiver
    // consumers may interleave file/index line order — line order is no longer
    // guaranteed to be commit order, the stamp (preserved from the atomic ledger
    // row) is. Array.sort is stable, so same-ms entries keep their stream order.
    entries.sort((a, b) => a.stamp - b.stamp);

    let replayed = 0;
    for (const entry of entries) {
        const absPath = path.join(logDir, entry.logFile);
        if (!fs.existsSync(absPath)) continue;

        const content = fs.readFileSync(absPath, 'utf8');
        const lines = content.trim().split('\n');
        let logEntry = null;

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.stamp === entry.stamp) { logEntry = parsed; break; }
            } catch (e) { continue; }
        }

        if (!logEntry) continue;

        const parts = entry.key.split(':');
        const indexKey = parts.length >= 3 ? `${parts[0]}:${parts[1]}:INDEX` : null;
        const entityId = parts.length >= 3 ? parts.slice(2).join(':') : null;

        switch (logEntry.op) {
            case 'create':
            case 'update':
                if (!logEntry.after) break;
                await redis.set(entry.key, JSON.stringify(logEntry.after));
                if (logEntry.op === 'create' && indexKey && entityId) {
                    await redis.sAdd(indexKey, entityId);
                }
                replayed++;
                break;
            case 'delete':
            case 'destroy':
                await redis.del(entry.key);
                if (indexKey && entityId) await redis.sRem(indexKey, entityId);
                replayed++;
                break;
        }
    }

    return { replayed, total: entries.length };
}

// --- Main Test ---

async function main() {
    console.log('');
    console.log('=== WAL Disaster Recovery Test ===');
    console.log(`Redis: ${REDIS_URL}`);
    console.log(`Test logs: ${TEST_LOG_DIR}`);
    console.log('');

    // Clean up test log directory
    cleanDir(TEST_LOG_DIR);

    // Connect to Redis
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (err) => console.error('Redis error:', err.message));
    await redis.connect();

    // Create test entity factory (using TEST_ prefix to isolate)
    const testEntity = createEntity(redis, {
        serviceName: 'WALTEST',
        entityName: 'ITEM',
        idLength: 8,
        softDelete: true,
        sensitiveFields: ['secret']
    });

    const testUid = 'testuser_abc123';

    try {
        // ============================================
        // Phase 1: Pre-snapshot writes
        // ============================================
        console.log('--- Phase 1: Pre-snapshot writes ---');

        let preItem;
        await walContext.run({ uid: testUid }, async () => {
            preItem = await testEntity.create({ name: 'pre-snapshot item', value: 100 });
        });
        console.log(`  Created pre-snapshot: ${preItem.id}`);

        // ============================================
        // Phase 2: Snapshot marker
        // ============================================
        console.log('');
        console.log('--- Phase 2: Snapshot ---');
        const snapshotStamp = Date.now();
        logger.snapshot('test-backup.rdb');
        console.log(`  Snapshot at: ${snapshotStamp}`);

        // Small delay to ensure post-snapshot stamps are different
        await new Promise(r => setTimeout(r, 10));

        // ============================================
        // Phase 3: Post-snapshot writes (these will be "lost")
        // ============================================
        console.log('');
        console.log('--- Phase 3: Post-snapshot writes ---');

        let item1, item2, item3;
        await walContext.run({ uid: testUid }, async () => {
            // Create 3 items
            item1 = await testEntity.create({ name: 'alpha', value: 10, secret: 'hidden123' });
            item2 = await testEntity.create({ name: 'beta', value: 20 });
            item3 = await testEntity.create({ name: 'gamma', value: 30 });
            console.log(`  Created: ${item1.id}, ${item2.id}, ${item3.id}`);

            // Update item1
            item1 = await testEntity.update({ id: item1.id, name: 'alpha-updated', value: 15 });
            console.log(`  Updated: ${item1.id} → alpha-updated`);

            // Soft-delete item3
            await testEntity.delete({ id: item3.id });
            console.log(`  Deleted: ${item3.id} (soft)`);
        });

        // Record expected state
        const expectedItem1 = { ...item1 };
        const expectedItem2 = { ...item2 };

        // ============================================
        // Phase 3.5: Drain the WAL stream into files
        // ============================================
        // Entity ledger rows now land atomically in WAL:STREAM (entity.js walMulti);
        // the file WAL this recovery replays from is produced by the archiver.
        // Drain it explicitly here — this also makes the test cover the full
        // production pipeline: atomic stream ledger → archiver → file → replay.
        console.log('');
        console.log('--- Phase 3.5: Archive WAL stream → files ---');
        const { createWalArchiver } = require('../walarchiver');
        const archiver = createWalArchiver(redis, { blockMs: 100, consumer: 'wal-recovery-test' });
        await archiver.ensureGroup(redis);
        let drained = 0;
        for (let i = 0; i < 50; i++) {
            const n = await archiver.drainOnce(redis);
            drained += n;
            if (n === 0) break;
        }
        console.log(`  Archived ${drained} ledger entries to ${TEST_LOG_DIR}`);

        // ============================================
        // Phase 4: Verify WAL files exist
        // ============================================
        console.log('');
        console.log('--- Phase 4: Verify WAL index ---');

        const walDir = path.join(TEST_LOG_DIR, 'wal');
        assert(fs.existsSync(walDir), 'WAL index directory exists');

        const years = fs.readdirSync(walDir);
        assert(years.length > 0, 'Year directory exists');

        const yearDir = path.join(walDir, years[0]);
        const indexFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.index'));
        assert(indexFiles.length > 0, 'Daily index file exists');

        const indexContent = fs.readFileSync(path.join(yearDir, indexFiles[0]), 'utf8');
        const indexLines = indexContent.trim().split('\n');
        assert(indexLines.length >= 6, `Index has ${indexLines.length} entries (expect ≥6: 1 pre + 1 snapshot + 3 create + 1 update + 1 delete)`);

        // Check snapshot marker
        const snapshotLine = indexLines.find(l => l.includes('|snapshot|'));
        assert(!!snapshotLine, 'Snapshot marker found in index');

        // Check sensitive field redaction in data logs
        const item1Key = `WALTEST:ITEM:${item1.id}`;
        const logEntries = logger.query(item1Key, TEST_LOG_DIR);
        const createEntry = logEntries.find(e => e.op === 'create');
        assert(createEntry && createEntry.after.secret === '[REDACTED]', 'Sensitive field redacted in log');

        // Check uid in log
        assert(createEntry && createEntry.user === testUid, `User UID recorded: ${createEntry?.user}`);

        // ============================================
        // Phase 5: Simulate disaster
        // ============================================
        console.log('');
        console.log('--- Phase 5: Simulate disaster ---');

        // Delete post-snapshot data from Redis (simulating crash + RDB restore to snapshot point)
        const key1 = `WALTEST:ITEM:${item1.id}`;
        const key2 = `WALTEST:ITEM:${item2.id}`;
        const key3 = `WALTEST:ITEM:${item3.id}`;
        const indexKey = 'WALTEST:ITEM:INDEX';

        await redis.del(key1);
        await redis.del(key2);
        await redis.del(key3);
        await redis.sRem(indexKey, item1.id);
        await redis.sRem(indexKey, item2.id);
        await redis.sRem(indexKey, item3.id);

        // Verify data is gone
        const gone1 = await redis.get(key1);
        const gone2 = await redis.get(key2);
        assert(gone1 === null, 'Item1 deleted from Redis (disaster simulated)');
        assert(gone2 === null, 'Item2 deleted from Redis (disaster simulated)');

        // ============================================
        // Phase 6: Recovery
        // ============================================
        console.log('');
        console.log('--- Phase 6: WAL Recovery ---');

        const result = await recoverAfter(redis, snapshotStamp, TEST_LOG_DIR);
        console.log(`  Replayed ${result.replayed}/${result.total} entries`);
        assert(result.replayed >= 5, `Replayed ≥5 entries (got ${result.replayed})`);

        // ============================================
        // Phase 7: Verify recovered data
        // ============================================
        console.log('');
        console.log('--- Phase 7: Verify recovery ---');

        // Item1 should be updated version
        const recovered1 = JSON.parse(await redis.get(key1));
        assert(recovered1 !== null, 'Item1 recovered');
        assert(recovered1.name === 'alpha-updated', `Item1 name: ${recovered1.name} (expect alpha-updated)`);
        assert(recovered1.value === 15, `Item1 value: ${recovered1.value} (expect 15)`);

        // Item2 should be original
        const recovered2 = JSON.parse(await redis.get(key2));
        assert(recovered2 !== null, 'Item2 recovered');
        assert(recovered2.name === 'beta', `Item2 name: ${recovered2.name} (expect beta)`);

        // Item3 should be soft-deleted (status=DELETED, data still exists)
        const recovered3 = JSON.parse(await redis.get(key3));
        assert(recovered3 !== null, 'Item3 recovered (soft-deleted)');
        assert(recovered3.status === 'DELETED', `Item3 status: ${recovered3.status} (expect DELETED)`);

        // Index should have item1 and item2 (item3 was soft-deleted, still in index)
        const members = await redis.sMembers(indexKey);
        assert(members.includes(item1.id), 'Item1 in index');
        assert(members.includes(item2.id), 'Item2 in index');

        // ============================================
        // Cleanup
        // ============================================
        console.log('');
        console.log('--- Cleanup ---');
        await redis.del(key1, key2, key3, indexKey);
        const preKey = `WALTEST:ITEM:${preItem.id}`;
        await redis.del(preKey);
        await redis.sRem(indexKey, preItem.id);
        cleanDir(TEST_LOG_DIR);
        console.log('  Test data cleaned');

    } finally {
        await redis.disconnect();
    }

    console.log('');
    if (process.exitCode) {
        console.log('=== SOME TESTS FAILED ===');
    } else {
        console.log('=== ALL TESTS PASSED ===');
    }
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
