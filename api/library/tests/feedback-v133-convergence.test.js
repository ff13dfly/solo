/**
 * Regression & convergence test suite for:
 *  1. docs/feedback/solo-v1.3.3-security-feedback.md
 *  2. docs/feedback/storage-visibility-logger-redaction-and-entity-ownable.md
 *  3. docs/feedback/steward-remaining-bypasses-convergence.md
 *  4. docs/feedback/cron-to-service-no-light-path.md
 */

jest.mock('worker_threads', () => {
    const { EventEmitter } = require('events');
    const crypto = require('crypto');
    class FakeWorker extends EventEmitter {
        postMessage({ taskId, type, payload }) {
            if (type === 'HASH') {
                const sha256 = crypto.createHash('sha256').update(payload.buffer).digest('hex');
                setImmediate(() => this.emit('message', { taskId, type: 'HASH_RESULT', payload: { sha256 } }));
            } else {
                setImmediate(() => this.emit('message', { taskId, type: 'ERROR', payload: `unsupported ${type}` }));
            }
        }
    }
    return { Worker: FakeWorker };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('redis');

const { isInternalOrReservedHost, assertPublicHostname } = require('../ssrf');
const { redactSensitive } = require('../logger');
const createEntity = require('../entity');
const { walContext } = require('../entity');
const { generateId } = require('../generator');

const HAS_SOLO_SOURCE_TREE = fs.existsSync(path.join(__dirname, '../../core/user/index.js'))
    && fs.existsSync(path.join(__dirname, '../../apps/storage/oss/index.js'));

const { createStorageProvider, createLocalOssServer } = HAS_SOLO_SOURCE_TREE ? require('../../apps/storage/oss') : {};
const createAssetLogic = HAS_SOLO_SOURCE_TREE ? require('../../apps/storage/logic/asset') : null;
const storageConfig = HAS_SOLO_SOURCE_TREE ? require('../../apps/storage/config') : null;
const createFulfillmentLogic = HAS_SOLO_SOURCE_TREE ? require('../../apps/fulfillment/logic') : null;
const fulfillmentConfig = HAS_SOLO_SOURCE_TREE ? require('../../apps/fulfillment/config') : null;
const createScheduleLogic = HAS_SOLO_SOURCE_TREE ? require('../../core/nexus/logic/schedule') : null;
const createSchedulerLogic = HAS_SOLO_SOURCE_TREE ? require('../../core/nexus/logic/scheduler') : null;
const nexusConfig = HAS_SOLO_SOURCE_TREE ? require('../../core/nexus/config') : null;
const { fetchAttachments } = HAS_SOLO_SOURCE_TREE ? require('../../core/gateway/logic/attachments') : {};
const { createImapEntity } = HAS_SOLO_SOURCE_TREE ? require('../../core/gateway/logic/imap') : {};
const createUserLogic = HAS_SOLO_SOURCE_TREE ? require('../../core/user/logic/user') : null;
const createRoleLogic = HAS_SOLO_SOURCE_TREE ? require('../../core/user/logic/role') : null;
const userConfig = HAS_SOLO_SOURCE_TREE ? require('../../core/user/config') : null;

const { spawn } = require('child_process');
const net = require('net');
const REDIS_CANDIDATES = [
    process.env.TEST_REDIS_URL,
    process.env.REDIS_URL,
    'redis://127.0.0.1:6379',
    'redis://127.0.0.1:6399',
].filter(Boolean);
const describeInSoloRepo = HAS_SOLO_SOURCE_TREE ? describe : describe.skip;

async function pickFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

describeInSoloRepo('SOLO v1.3.3 Security & Convergence Feedback Suite', () => {
    let redis;
    let spawnedRedisProc = null;

    beforeAll(async () => {
        process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret-key-32-chars!!';
        for (const url of REDIS_CANDIDATES) {
            const client = createClient({
                url,
                database: 13,
                socket: { reconnectStrategy: false, connectTimeout: 500 },
            });
            client.on('error', () => {});
            try {
                await client.connect();
                await client.flushDb();
                redis = client;
                break;
            } catch (_) {
                try { client.destroy(); } catch (_e) {}
            }
        }
        if (!redis) {
            const port = await pickFreePort();
            spawnedRedisProc = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], {
                stdio: 'ignore',
            });
            const url = `redis://127.0.0.1:${port}`;
            for (let i = 0; i < 20; i++) {
                await new Promise((r) => setTimeout(r, 80));
                const client = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 500 } });
                client.on('error', () => {});
                try {
                    await client.connect();
                    redis = client;
                    break;
                } catch (_) {
                    try { client.destroy(); } catch (_e) {}
                }
            }
        }
        if (!redis) throw new Error('No local Redis available for test');
        try {
            await redis.json.set('__json_probe__', '$', { ok: 1 });
            await redis.del('__json_probe__');
        } catch (_) {
            redis.json.set = async (k, _p, val) => redis.set(k, JSON.stringify(val));
            redis.json.get = async (k) => {
                const raw = await redis.get(k);
                return raw ? JSON.parse(raw) : null;
            };
        }
    });

    afterAll(async () => {
        if (redis) {
            if (redis.isOpen) {
                await redis.flushDb().catch(() => {});
                await redis.quit().catch(() => {});
            } else {
                try { redis.destroy(); } catch (_) {}
            }
        }
        if (spawnedRedisProc) {
            try { spawnedRedisProc.kill('SIGTERM'); } catch (_) {}
            spawnedRedisProc = null;
        }
    });

    // -----------------------------------------------------------------------
    // 1. Shared SSRF Protection (library/ssrf.js)
    // -----------------------------------------------------------------------
    describe('library/ssrf.js — CGNAT / Tailscale / Cloud Metadata / IPv6 / DNS guard', () => {
        test('blocks loopback, RFC1918, link-local, CGNAT (100.64/10 & 100.100.100.200), benchmark, multicast, IPv6 ULA/mapped', () => {
            const blockedHosts = [
                '127.0.0.1',
                'localhost',
                'sub.localhost',
                '0.0.0.0',
                '10.0.0.1',
                '172.16.0.1',
                '172.31.255.255',
                '192.168.1.1',
                '169.254.169.254',
                'metadata.google.internal',
                'service.internal',
                '100.64.0.1',         // Tailscale / CGNAT
                '100.100.100.200',    // Alibaba Cloud metadata
                '100.127.255.254',    // End of 100.64.0.0/10
                '198.18.0.1',         // Benchmark
                '224.0.0.1',          // Multicast
                '::1',
                '::',
                '::ffff:127.0.0.1',
                '::ffff:100.100.100.200',
                'fe80::1',
                'fc00::1',
                'fd12:3456::1',
            ];
            for (const host of blockedHosts) {
                expect(isInternalOrReservedHost(host)).toBe(true);
            }

            const allowedHosts = ['8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', 'example.com'];
            for (const host of allowedHosts) {
                expect(isInternalOrReservedHost(host)).toBe(false);
            }
        });

        test('assertPublicHostname rejects DNS rebinding to private/CGNAT IP', async () => {
            await expect(
                assertPublicHostname('evil.example.com', {
                    lookupFn: async () => [{ address: '100.100.100.200', family: 4 }],
                })
            ).rejects.toThrow(/resolved to internal\/reserved IP/);
        });
    });

    // -----------------------------------------------------------------------
    // 2. Logger Redaction & Blob Truncation (library/logger.js)
    // -----------------------------------------------------------------------
    describe('library/logger.js — compound key redaction, depth 6, and base64/blob truncation', () => {
        test('masks camelCase/compound credential keys and sealedInputs up to depth 6', () => {
            const input = {
                smtpPass: 'smtp-secret',
                imapPass: 'imap-secret',
                passphrase: 'key-passphrase',
                privateKey: '-----BEGIN PRIVATE KEY-----',
                apiKey: 'sk-12345',
                authToken: 'bearer-xyz',
                sealedInputs: { accountPass: 'plain' },
                l1: { l2: { l3: { l4: { l5: { l6: { accessKeySecret: 'deep-ak-secret' } } } } } },
            };
            const out = redactSensitive(input);
            expect(out.smtpPass).toBe('***');
            expect(out.imapPass).toBe('***');
            expect(out.passphrase).toBe('***');
            expect(out.privateKey).toBe('***');
            expect(out.apiKey).toBe('***');
            expect(out.authToken).toBe('***');
            expect(out.sealedInputs).toBe('***');
            expect(out.l1.l2.l3.l4.l5.l6.accessKeySecret).toBe('***');
        });

        test('truncates data:*;base64 URIs, large base64/content fields, and strings > 4096 chars', () => {
            const dataUri = 'data:image/png;base64,' + 'A'.repeat(500);
            const rawBase64 = 'B'.repeat(600);
            const hugeString = 'C'.repeat(5000);
            const out = redactSensitive({
                avatar: dataUri,
                base64: rawBase64,
                normalField: hugeString,
                shortField: 'hello',
            });
            expect(out.avatar).toMatch(/^\[TRUNCATED len=\d+\]$/);
            expect(out.base64).toMatch(/^\[TRUNCATED len=600\]$/);
            expect(out.normalField).toMatch(/^\[TRUNCATED len=5000\]$/);
            expect(out.shortField).toBe('hello');
        });
    });

    // -----------------------------------------------------------------------
    // 3. EntityFactory ownable: false (library/entity.js)
    // -----------------------------------------------------------------------
    describe('library/entity.js — EntityFactory({ ownable: false })', () => {
        test('skips $owner stamping and row filtering when ownable is false while keeping WAL context', async () => {
            const dictEntity = createEntity(redis, {
                serviceName: 'TESTDICT',
                entityName: 'PLATFORM',
                idLength: 8,
                ownable: false,
            });

            let created;
            await walContext.run(
                { uid: 'USR-ALICE', owner: { field: 'ownerId', value: 'USR-ALICE' }, trace: 'tr-dict-1' },
                async () => {
                    created = await dictEntity.create({ code: 'PLAT_TEMU', title: 'Temu Global' });
                }
            );

            const raw = JSON.parse(await redis.get(`TESTDICT:PLATFORM:${created.id}`));
            expect(raw.ownerId).toBeUndefined();

            // Another scoped user can read and list the global dictionary record
            await walContext.run(
                { uid: 'USR-BOB', owner: { field: 'ownerId', value: 'USR-BOB' } },
                async () => {
                    const got = await dictEntity.get({ id: created.id });
                    expect(got.title).toBe('Temu Global');
                    const listed = await dictEntity.list({});
                    expect(listed.items.some(item => item.id === created.id)).toBe(true);
                }
            );
        });
    });

    // -----------------------------------------------------------------------
    // 4. Fulfillment: INCR+SET NX ID, _ownerScope, and cancel from suspend
    // -----------------------------------------------------------------------
    describe('apps/fulfillment — atomic ID, _ownerScope on reap, and cancel from suspend', () => {
        let logic;

        beforeEach(async () => {
            await redis.flushDb();
            logic = createFulfillmentLogic(redis, fulfillmentConfig, {
                relay: {
                    call: async () => ({ ok: true }),
                },
            });

            await logic.profile.create({
                id: 'test-suspend-flow',
                name: 'Suspend Test Flow',
                version: 1,
                states: {
                    DRAFT: { label: 'Draft' },
                    COLLECTING: { label: 'Collecting' },
                    ASSIST_REQUIRED: { label: 'Assist Required' },
                    COMPLETED: { label: 'Completed', terminal: true },
                    FAILED: { label: 'Failed', terminal: true },
                    CANCELLED: { label: 'Cancelled', terminal: true },
                },
                stateTtls: {
                    DRAFT: { ttlMs: 1000, event: 'timeout_expired', reason: 'Draft timed out' },
                },
                transitions: [
                    { from: 'DRAFT', to: 'COLLECTING', event: 'start', actions: [] },
                    {
                        from: 'DRAFT',
                        to: 'FAILED',
                        event: 'timeout_expired',
                        actions: [{ type: 'rpc', method: 'steward.task.fail', params: { reason: 'ttl' } }],
                    },
                    { from: 'DRAFT', to: 'CANCELLED', event: 'cancel_requested', actions: [] },
                    { from: 'COLLECTING', to: 'CANCELLED', event: 'cancel_requested', actions: [] },
                ],
            });
        });

        test('creates sequential FL-YYYYMMDD-NNNN IDs via INCR + SET NX and strips _-prefixed meta keys', async () => {
            const reqA = { user: 'USR-T1', constraints: { $owner: { field: 'ownerId', value: 'TENANT-A' } } };
            const c1 = await logic.instance.create(
                { profileId: 'test-suspend-flow', sourceId: 'SRC-1', meta: { orderNo: 'ORD-1', _internalSecret: 'should-strip' } },
                reqA
            );
            const c2 = await logic.instance.create(
                { profileId: 'test-suspend-flow', sourceId: 'SRC-2', meta: { orderNo: 'ORD-2' } },
                reqA
            );
            expect(c1.id).toMatch(/^FL-\d{8}-0001$/);
            expect(c2.id).toMatch(/^FL-\d{8}-0002$/);
            expect(c1.meta._internalSecret).toBeUndefined();
        });

        test('allows cancelling an instance in orthogonal suspend state (ASSIST_REQUIRED) and updates meta', async () => {
            const reqA = { user: 'USR-T1', constraints: { $owner: { field: 'ownerId', value: 'TENANT-A' } } };
            const created = await logic.instance.create(
                { profileId: 'test-suspend-flow', sourceId: 'SRC-SUSP', meta: { site: 'temu' } },
                reqA
            );
            await logic.instance.transition({ id: created.id, event: 'start' }, reqA);
            const suspended = await logic.instance.suspend(
                { id: created.id, reason: 'OTP_REQUIRED', checkpoint: { step: 2 } },
                reqA
            );
            expect(suspended.state).toBe('ASSIST_REQUIRED');
            expect(suspended.suspension).toBeTruthy();

            const cancelled = await logic.instance.cancel(
                { id: created.id, reason: 'user_aborted', metaUpdate: { abortNote: 'cancelled during 2FA' } },
                reqA
            );
            expect(cancelled.state).toBe('CANCELLED');
            expect(cancelled.suspension).toBeNull();
            expect(cancelled.meta.cancel_reason).toBe('user_aborted');
            expect(cancelled.meta.abortNote).toBe('cancelled during 2FA');
        });

        test('reap preserves tenant _ownerScope in returned _tasks', async () => {
            const reqA = { user: 'USR-T1', constraints: { $owner: { field: 'ownerId', value: 'TENANT-A' } } };
            const created = await logic.instance.create(
                { profileId: 'test-suspend-flow', sourceId: 'SRC-REAP' },
                reqA
            );
            // Age the instance past its 1000ms stateTtl
            const raw = JSON.parse(await redis.get(`${fulfillmentConfig.redis.instancePrefix}${created.id}`));
            raw.stateChangedAt = Date.now() - 5000;
            await redis.set(`${fulfillmentConfig.redis.instancePrefix}${created.id}`, JSON.stringify(raw));

            const reaped = await logic.instance.reap({}, { user: 'system:reaper', permit: 'admin' });
            expect(reaped.reaped.length).toBe(1);
            expect(reaped._tasks.length).toBe(1);
            expect(reaped._tasks[0]._owner).toEqual({ field: 'ownerId', value: 'TENANT-A' });
        });
    });

    // -----------------------------------------------------------------------
    // 5. Storage: visibility signing, presign+commit, TTL reap, rebuild auth
    // -----------------------------------------------------------------------
    describe('apps/storage — per-asset visibility signing, presign/commit, ttlSec/reap, local-oss guard', () => {
        let tmpDir;
        let ossServer;
        let ossEndpoint;
        let store;
        let assets;

        beforeAll(async () => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-storage-v133-'));
            ossServer = createLocalOssServer({
                root: tmpDir,
                secret: 'test-oss-secret-v133',
                bucket: 'v133',
                publicRead: true, // Even when publicRead is true, non-public objects must require signature!
            });
            const port = await ossServer.listen(0);
            ossEndpoint = `http://localhost:${port}`;

            store = createStorageProvider({
                provider: 'local',
                access: 'public', // Even when STORAGE_ACCESS=public, private/internal must sign!
                signedUrlTtl: 600,
                local: {
                    endpoint: ossEndpoint,
                    bucket: 'v133',
                    secret: 'test-oss-secret-v133',
                    outwardOrigin: ossEndpoint,
                },
            });

            assets = createAssetLogic(redis, storageConfig, store);
        });

        afterAll(async () => {
            if (ossServer) await ossServer.close();
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        test('signs URLs for private and internal assets even when access=public, and local-oss rejects unsigned GET on non-public object', async () => {
            const priv = await assets.upload(
                {
                    filename: 'secret.txt',
                    mimeType: 'text/plain',
                    visibility: 'private',
                    file: Buffer.from('top-secret-content').toString('base64'),
                },
                { user: 'USR-1' }
            );
            expect(priv.url).toContain('Expires=');
            expect(priv.url).toContain('Signature=');

            // Unsigned request to local-oss must be rejected (403) because visibility is 'private'
            const unsignedUrl = priv.url.split('?')[0];
            const unsignedRes = await fetch(unsignedUrl);
            expect(unsignedRes.status).toBe(403);

            // Signed request succeeds
            const signedRes = await fetch(priv.url);
            expect(signedRes.status).toBe(200);
            expect(await signedRes.text()).toBe('top-secret-content');

            // Public asset returns unsigned URL and allows unsigned GET
            const pub = await assets.upload(
                {
                    filename: 'public.txt',
                    mimeType: 'text/plain',
                    visibility: 'public',
                    file: Buffer.from('hello-public').toString('base64'),
                },
                { user: 'USR-1' }
            );
            expect(pub.url).not.toContain('sig=');
            const pubRes = await fetch(pub.url);
            expect(pubRes.status).toBe(200);
        });

        test('presign + direct PUT + commit workflow and CAS instant deduplication', async () => {
            const payload = Buffer.from('direct-put-binary-payload-' + Date.now());
            const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

            const presigned = await assets.presign(
                {
                    filename: 'bundle.bin',
                    mimeType: 'application/octet-stream',
                    size: payload.length,
                    sha256,
                    visibility: 'internal',
                },
                { user: 'USR-UPLOADER' }
            );
            expect(presigned.alreadyExists).toBe(false);
            expect(presigned.ticket).toBeTruthy();
            expect(presigned.uploadUrl).toContain('Signature=');

            // Client uploads directly to OSS uploadUrl
            const putRes = await fetch(presigned.uploadUrl, {
                method: 'PUT',
                headers: { 'content-type': presigned.contentType },
                body: payload,
            });
            expect(putRes.status).toBe(200);

            // Commit ticket
            const committed = await assets.commit(
                { ticket: presigned.ticket },
                { user: 'USR-UPLOADER' }
            );
            expect(committed.id).toBeTruthy();
            expect(committed.sha256).toBe(sha256);
            expect(committed.size).toBe(payload.length);

            // Second presign with same sha256 hits CAS instant deduplication
            const dedup = await assets.presign(
                {
                    filename: 'bundle-copy.bin',
                    mimeType: 'application/octet-stream',
                    size: payload.length,
                    sha256,
                    visibility: 'internal',
                },
                { user: 'USR-UPLOADER' }
            );
            expect(dedup.alreadyExists).toBe(true);
            expect(dedup.uploadUrl).toBeNull();

            // Commit dedup ticket without re-uploading bytes
            const committedDedup = await assets.commit(
                { ticket: dedup.ticket },
                { user: 'USR-UPLOADER' }
            );
            expect(committedDedup.sha256).toBe(sha256);
        });

        test('ttlSec + storage.asset.reap + delegateDelete / system.* bot delete', async () => {
            const tempAsset = await assets.upload(
                {
                    filename: 'ephemeral-otp.txt',
                    mimeType: 'text/plain',
                    visibility: 'private',
                    ttlSec: 60,
                    delegateDelete: 'USR-DELEGATE',
                    file: Buffer.from('ephemeral-' + Date.now()).toString('base64'),
                },
                { user: 'USR-OWNER' }
            );
            expect(new Date(tempAsset.expiresAt).getTime()).toBeGreaterThan(Date.now());

            // Non-authorized user cannot delete
            await expect(
                assets.delete({ id: tempAsset.id }, { user: 'USR-STRANGER' })
            ).rejects.toMatchObject({ code: -32005 });

            // Delegated user CAN delete
            const delRes = await assets.delete({ id: tempAsset.id }, { user: 'USR-DELEGATE' });
            expect(delRes.deleted).toBe(tempAsset.id);

            // Create another temp asset and expire it for reap()
            const expiringAsset = await assets.upload(
                {
                    filename: 'reap-me.txt',
                    mimeType: 'text/plain',
                    visibility: 'private',
                    ttlSec: 60,
                    file: Buffer.from('reap-payload-' + Date.now()).toString('base64'),
                },
                { user: 'USR-OWNER' }
            );
            // Move expiry to the past
            const pastTs = Date.now() - 5000;
            const rawMeta = JSON.parse(await redis.get(`${storageConfig.redis.assetPrefix}${expiringAsset.id}`));
            rawMeta.expiresAt = pastTs;
            await redis.set(`${storageConfig.redis.assetPrefix}${expiringAsset.id}`, JSON.stringify(rawMeta));
            await redis.zAdd(storageConfig.redis.assetExpiresSortedSet || 'STORAGE:ASSETS:EXPIRES', {
                score: pastTs,
                value: expiringAsset.id,
            });

            // Lazy get returns NOT_FOUND (expired)
            await expect(
                assets.get({ id: expiringAsset.id }, { user: 'USR-OWNER' })
            ).rejects.toMatchObject({ code: -32002 });

            // Reap cleans any due items
            const reapRes = await assets.reap({ limit: 20 });
            expect(typeof reapRes.reaped).toBe('number');
        });

        test('thumbnailRebuild enforces admin or asset-owner authorization', async () => {
            await expect(
                assets.thumbnailRebuild({}, { user: 'USR-1', permit: 'user' })
            ).rejects.toMatchObject({ code: -32003 });
        });
    });

    // -----------------------------------------------------------------------
    // 6. Nexus: call_method schedule & system.<svc> bot namespace isolation
    // -----------------------------------------------------------------------
    describe('core/nexus — call_method action & system.<svc> bot namespace isolation', () => {
        let schedule;
        let scheduler;
        let relayCalls;

        beforeEach(async () => {
            await redis.flushDb();
            relayCalls = [];
            const relay = {
                call: async (method, params) => {
                    relayCalls.push({ method, params });
                    return { ok: true };
                },
            };
            schedule = createScheduleLogic(redis, { config: nexusConfig });
            scheduler = createSchedulerLogic(redis, {
                config: nexusConfig,
                relay,
            });
        });

        test('allows call_method schedule and dispatches relay.call on tick, while enforcing bot namespace isolation', async () => {
            const botCtx = { user: 'system.steward', isAdmin: false, owner: null };
            const created = await schedule.create(
                {
                    schedule_id: 'steward:heartbeat-sweep',
                    fire_at: Date.now() - 1000,
                    recurrence_ms: 10000,
                    action: {
                        kind: 'call_method',
                        method: 'steward.node.sweep',
                        params: { staleSec: 1800 },
                    },
                },
                botCtx
            );
            expect(created.schedule_id).toBe('steward:heartbeat-sweep');
            expect(created.owner).toBe('system.steward');

            // Bot cannot create schedule outside its service prefix
            await expect(
                schedule.create(
                    {
                        schedule_id: 'finance:rogue',
                        fire_at: Date.now() + 5000,
                        action: { kind: 'call_method', method: 'steward.node.sweep' },
                    },
                    botCtx
                )
            ).rejects.toMatchObject({ message: expect.stringMatching(/must prefix schedule_id/) });

            // Bot cannot schedule call_method outside its service namespace
            await expect(
                schedule.create(
                    {
                        schedule_id: 'steward:rogue-call',
                        fire_at: Date.now() + 5000,
                        action: { kind: 'call_method', method: 'finance.ledger.close' },
                    },
                    botCtx
                )
            ).rejects.toMatchObject({ message: expect.stringMatching(/can only schedule call_method within/) });

            // Tick scheduler to execute due call_method
            await scheduler.tick();
            expect(relayCalls.length).toBe(1);
            expect(relayCalls[0].method).toBe('steward.node.sweep');
            expect(relayCalls[0].params.staleSec).toBe(1800);
            expect(relayCalls[0].params.idempotency_key).toContain('steward:heartbeat-sweep:');

            // Blocks high-privilege methods in call_method even for admin
            await expect(
                schedule.create(
                    {
                        schedule_id: 'bad-sched',
                        fire_at: Date.now() + 5000,
                        action: { kind: 'call_method', method: 'user.permit.set', params: {} },
                    },
                    { user: 'admin', isAdmin: true }
                )
            ).rejects.toMatchObject({ message: expect.stringMatching(/forbidden in scheduled actions/) });
        });
    });

    // -----------------------------------------------------------------------
    // 7. Gateway: attachment callerCtx authz + SSRF & gateway.imap
    // -----------------------------------------------------------------------
    describe('core/gateway — attachment callerCtx authorization & gateway.imap', () => {
        test('fetchAttachments blocks cross-user private assets, cross-tenant internal assets, and SSRF external URLs', async () => {
            const mockRelay = {
                call: async (method, params) => {
                    if (method === 'storage.asset.get') {
                        if (params.id === 'AST-PRIVATE-OTHER') {
                            return {
                                id: 'AST-PRIVATE-OTHER',
                                visibility: 'private',
                                owner: 'USR-VICTIM',
                                size: 10,
                                mimeType: 'text/plain',
                            };
                        }
                        if (params.id === 'AST-INTERNAL-OTHER-TENANT') {
                            return {
                                id: 'AST-INTERNAL-OTHER-TENANT',
                                visibility: 'internal',
                                owner: 'TENANT-2',
                                size: 10,
                                mimeType: 'text/plain',
                            };
                        }
                        if (params.id === 'AST-EXTERNAL-SSRF') {
                            return {
                                id: 'AST-EXTERNAL-SSRF',
                                visibility: 'public',
                                kind: 'external',
                                size: 10,
                                mimeType: 'text/plain',
                            };
                        }
                    }
                    if (method === 'storage.asset.resolve') {
                        return { url: 'http://100.100.100.200/latest/meta-data/' };
                    }
                },
            };

            await expect(
                fetchAttachments(mockRelay, [{ assetId: 'AST-PRIVATE-OTHER' }], {
                    callerCtx: { user: 'USR-ATTACKER', permit: 'user', owner: null },
                })
            ).rejects.toThrow(/No access to attachment asset/);

            await expect(
                fetchAttachments(mockRelay, [{ assetId: 'AST-INTERNAL-OTHER-TENANT' }], {
                    callerCtx: { user: 'USR-T1', permit: 'user', owner: { field: 'ownerId', value: 'TENANT-1' } },
                })
            ).rejects.toThrow(/No access to attachment asset/);

            await expect(
                fetchAttachments(mockRelay, [{ assetId: 'AST-EXTERNAL-SSRF' }], {
                    callerCtx: { user: 'USR-T1', permit: 'user', owner: null },
                })
            ).rejects.toThrow(/internal\/metadata host/);
        });

        test('gateway.imap encrypts pass at rest, enforces port 993 + SSRF guard, and isolates by $owner', async () => {
            const imap = createImapEntity(redis);

            // Rejects non-993 port
            await expect(
                walContext.run({ uid: 'USR-A', owner: { field: 'ownerId', value: 'TENANT-A' } }, () =>
                    imap.create({ name: 'BadPort', host: 'imap.example.com', port: 143, user: 'u@example.com', pass: 'secret' })
                )
            ).rejects.toMatchObject({ message: expect.stringMatching(/port 993/) });

            // Rejects SSRF host
            await expect(
                walContext.run({ uid: 'USR-A', owner: { field: 'ownerId', value: 'TENANT-A' } }, () =>
                    imap.create({ name: 'SSRFHost', host: '100.100.100.200', port: 993, user: 'u@example.com', pass: 'secret' })
                )
            ).rejects.toMatchObject({ message: expect.stringMatching(/internal or reserved host/) });

            // Creates valid account with AES-256-GCM encrypted password (stripped from returned record)
            const created = await walContext.run({ uid: 'USR-A', owner: { field: 'ownerId', value: 'TENANT-A' } }, () =>
                imap.create({ name: 'CorpMail', host: 'imap.example.com', port: 993, user: 'bot@example.com', pass: 'my-imap-pass' })
            );
            expect(created.id).toBeTruthy();
            expect(created.pass).toBeUndefined();

            // Verify encrypted at rest in Redis
            const rawStored = JSON.parse(await redis.get(`GATEWAY:IMAP:${created.id}`));
            expect(rawStored.pass).not.toBe('my-imap-pass');
            expect(typeof rawStored.pass).toBe('string');
            expect(rawStored.pass.length).toBeGreaterThan(24);
            expect(rawStored.ownerId).toBe('TENANT-A');

            // Cross-tenant cannot read
            await expect(
                walContext.run({ uid: 'USR-B', owner: { field: 'ownerId', value: 'TENANT-B' } }, () =>
                    imap.get({ id: created.id })
                )
            ).rejects.toMatchObject({ code: -32002 });
        });
    });

    // -----------------------------------------------------------------------
    // 8. Core/User: user.session.logout, user.password.reset & controlled delegation
    // -----------------------------------------------------------------------
    describe('core/user — user.session.logout, user.password.reset, and controlled delegation', () => {
        test('sessionLogout revokes single session, passwordReset updates salt/hash + clears devices + kills sessions, and controlled delegation blocks privilege escalation', async () => {
            const userLogic = createUserLogic(redis, userConfig);
            const roleLogic = createRoleLogic(redis, userConfig);

            const uid = generateId(userConfig.idLengths?.user || 16);
            const adminUid = generateId(userConfig.idLengths?.user || 16);

            await redis.set(
                `${userConfig.redis.userPrefix}${uid}`,
                JSON.stringify({
                    uid,
                    name: 'targetuser',
                    salt: 'old-salt-12345678',
                    hash: 'old-hash-12345678901234567890123456789012',
                    devices: { 'dev-1': 'tok-1' },
                    permit: { services: {} },
                    categories: { POWER: 'normal' },
                })
            );
            await redis.set(
                `${userConfig.redis.userPrefix}${adminUid}`,
                JSON.stringify({
                    uid: adminUid,
                    name: 'rootadmin',
                    salt: 'adm-salt-12345678',
                    hash: 'adm-hash-12345678901234567890123456789012',
                    devices: {},
                    permit: 'admin',
                    categories: { POWER: 'admin' },
                })
            );

            // Seed two active sessions for uid
            await redis.setEx('session:tok-a', 3600, JSON.stringify({ uid }));
            await redis.setEx('session:tok-b', 3600, JSON.stringify({ uid }));
            await redis.sAdd(`USER:SESSIONS:${uid}`, 'tok-a');
            await redis.sAdd(`USER:SESSIONS:${uid}`, 'tok-b');

            // Single-token logout
            const singleOut = await userLogic.sessionLogout({ all: false, token: 'tok-a' }, { user: uid, token: 'tok-a' });
            expect(singleOut.revoked).toBe(1);
            expect(await redis.get('session:tok-a')).toBeNull();
            expect(await redis.get('session:tok-b')).not.toBeNull();

            // Non-admin delegated caller cannot reset an admin account's password
            const newSalt = '0123456789abcdef0123456789abcdef';
            const newHash = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
            await expect(
                userLogic.passwordReset({ uid: adminUid, salt: newSalt, hash: newHash }, { user: 'system.steward', isAdmin: false })
            ).rejects.toMatchObject({ message: expect.stringMatching(/cannot reset an admin account/) });

            // Password reset on regular user clears devices and kills remaining sessions
            const resetRes = await userLogic.passwordReset(
                { uid, salt: newSalt, hash: newHash },
                { user: 'system.steward', isAdmin: false }
            );
            expect(resetRes.uid).toBe(uid);
            expect(resetRes.revoked).toBe(1);

            const updatedUser = JSON.parse(await redis.get(`${userConfig.redis.userPrefix}${uid}`));
            expect(updatedUser.salt).toBe(newSalt);
            expect(updatedUser.hash).toBe(newHash);
            expect(updatedUser.devices).toEqual({});
            expect(await redis.get('session:tok-b')).toBeNull();

            // Non-admin delegated caller cannot set categories.POWER = 'admin'
            await expect(
                userLogic.update({ uid, categories: { POWER: 'admin' } }, { user: 'system.steward', isAdmin: false })
            ).rejects.toMatchObject({ message: expect.stringMatching(/cannot grant POWER=admin/) });

            // Non-admin delegated caller cannot assign a role containing privileged permits
            await roleLogic.set({
                role: 'dangerous_role',
                services: { user: ['user.permit.set'] },
            });
            await expect(
                roleLogic.assign({ uid, role: 'dangerous_role' }, { user: 'system.steward', isAdmin: false })
            ).rejects.toMatchObject({ message: expect.stringMatching(/administrative or privilege-escalation permissions/) });
        });
    });
});
