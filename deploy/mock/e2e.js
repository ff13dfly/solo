#!/usr/bin/env node
//
// e2e.js — end-to-end workflow run test (DEV ONLY). Run against a live dev stack.
//
// What it proves: a test user with a Redis-adjustable permit runs a multi-step
// workflow through the real Router → orchestrator → collection chain, and the
// PERMIT is the lever:
//   1. inject a test user with a MINIMAL permit + a session
//   2. inject an ACTIVE sync workflow (collection.payment.record → settle)
//   3. run it as the test user → expect BLOCKED (H6 footprint pre-check: missing collection)
//   4. adjust the user's permit in Redis to cover collection → run again → expect PASS
//   5. verify the side effect: the payment exists and is SETTLED
//
// This exercises: direct Redis user/session/permit injection, the H6 footprint
// pre-check (whose permit unwrap was fixed in runner.js), sync workflow execution,
// cross-service step calls through the Router, and $step result chaining.
//
// Prereq: bash deploy/dev.sh  (Router 8600 + orchestrator + user + collection up;
//         collection started via services.dev.json). RedisJSON required (redis-stack on 6699).
//
// Usage:
//   node deploy/mock/e2e.js           # run the test (cleans up after)
//   node deploy/mock/e2e.js --keep    # leave the injected user/workflow in Redis
//
const path = require('path');
const http = require('http');

const API_DIR = path.join(__dirname, '..', '..', 'api');
const { createClient } = require(path.join(API_DIR, 'node_modules', 'redis'));
const { generateId } = require(path.join(API_DIR, 'library', 'generator'));

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6699';
const ROUTER_URL = process.env.ROUTER_URL || 'http://127.0.0.1:8600';
const COLLECTION_URL = process.env.COLLECTION_URL || 'http://127.0.0.1:8055/jsonrpc';
const KEEP = process.argv.includes('--keep');

const WF_ID = 'wf-e2e-sync-collection';
const WF_KEY = `ORCHESTRATOR:WORKFLOW:${WF_ID}`;

// ── tiny JSON-RPC client over the Router ──────────────────────────────────────
function rpc(method, params, token) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} });
        const u = new URL(ROUTER_URL);
        const req = http.request({
            hostname: u.hostname, port: u.port || 80, path: '/', method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        }, (res) => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ _raw: buf, _status: res.statusCode }); } });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

// ── assertions ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

const PERMIT_MIN  = { allow_all: false, services: {} };
const PERMIT_FULL = { allow_all: false, services: { collection: ['*'] } };

async function setUserPermit(redis, uid, permit) {
    // user.permit.get reads user:{uid}; Router auth Scheme F also reads it and
    // overwrites the session permit — so user:{uid} is the single source of truth.
    const userDoc = { id: uid, name: 'e2e-test', permit, status: 'ACTIVE', createdAt: Date.now(), updatedAt: Date.now() };
    await redis.set(`user:${uid}`, JSON.stringify(userDoc));
}

(async () => {
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', e => console.error('redis error:', e.message));
    await redis.connect();

    const uid = generateId(16);
    const userToken = 'e2e-user-' + generateId(8);
    const adminToken = 'e2e-admin-' + generateId(8);
    const orderId = 'E2E-ORD-' + generateId(6);

    console.log(`E2E workflow run  (router=${ROUTER_URL}, uid=${uid}, order=${orderId})\n`);

    try {
        // 1. test user (MINIMAL permit) + sessions
        await setUserPermit(redis, uid, PERMIT_MIN);
        await redis.set(`user:name:e2e-test-${uid}`, uid);
        await redis.sAdd('user:ids', uid);
        await redis.set(`session:${userToken}`, JSON.stringify({ uid, username: 'e2e-test', permit: PERMIT_MIN }), { EX: 1800 });
        await redis.set(`session:${adminToken}`, JSON.stringify({ uid: 'e2e-admin', username: 'e2e-admin', permit: { allow_all: true } }), { EX: 1800 });
        console.log('  · injected test user (minimal permit) + admin session');

        // 2. make sure collection is registered with the Router (idempotent handshake)
        const reg = await rpc('system.service.add', { url: COLLECTION_URL }, adminToken);
        console.log(`  · collection register: ${reg.error ? 'error(' + reg.error.message + ') — may already be up' : 'ok'}`);

        // 3. inject the ACTIVE sync workflow
        const now = Date.now();
        const wf = {
            id: WF_ID, category: 'event-test', priority: 50,
            name: 'E2E sync (collection)', desc: 'record then settle a payment',
            tags: [], examples: [], negative: [], keywords: [],
            required_inputs: ['orderId', 'amount'], optional_inputs: [], synonyms: {},
            steps: [
                { id: 'record', service: 'collection', method: 'collection.payment.record', params: { source: 'e2e', orderId: '$input.orderId', amount: '$input.amount', currency: 'usd' } },
                { id: 'settle', service: 'collection', method: 'collection.payment.settle', params: { id: '$step.record.result.id' } },
            ],
            resolvers: {}, allowed_triggers: ['sync'],
            status: 'ACTIVE', submittedBy: 'ai-agent', approvals: [], createdAt: now, updatedAt: now,
        };
        await redis.json.set(WF_KEY, '$', wf);
        console.log('  · injected ACTIVE sync workflow\n');

        // 4. run with INSUFFICIENT permit → expect blocked by H6
        console.log('Test A — run with minimal permit (expect BLOCKED by footprint pre-check):');
        const runA = await rpc('orchestrator.workflow.run', { workflowId: WF_ID, input: { orderId, amount: 1234 } }, userToken);
        check('run is rejected (permit lever works)', !!runA.error, runA.error ? `error: ${runA.error.message}` : `unexpectedly ran: ${JSON.stringify(runA.result)}`);

        // 5. adjust permit in Redis to cover collection
        console.log('\nadjusting user permit in Redis → services.collection = ["*"] ...');
        await setUserPermit(redis, uid, PERMIT_FULL);

        // 6. run with SUFFICIENT permit → expect success
        console.log('\nTest B — run with full permit (expect SUCCESS):');
        const runB = await rpc('orchestrator.workflow.run', { workflowId: WF_ID, input: { orderId, amount: 1234 } }, userToken);
        check('run succeeds (no error)', !runB.error, runB.error ? `error: ${runB.error.message}` : '');
        const status = runB.result && runB.result.status;
        check('workflow status = completed', status === 'completed', `status=${status}`);

        // 7. verify side effect: payment exists and is SETTLED
        console.log('\nverify side effect (collection.payment.list as admin):');
        const list = await rpc('collection.payment.list', {}, adminToken);
        const items = (list.result && list.result.items) || [];
        const payment = items.find(p => p.orderId === orderId);
        check('payment was created for the order', !!payment, payment ? '' : `no payment with orderId=${orderId}`);
        check('payment state = SETTLED', payment && payment.state === 'SETTLED', payment ? `state=${payment.state}` : 'n/a');

    } finally {
        if (!KEEP) {
            await redis.del(`user:${uid}`, `user:name:e2e-test-${uid}`, `session:${userToken}`, `session:${adminToken}`, WF_KEY);
            await redis.sRem('user:ids', uid);
            console.log('\n· cleaned up injected user/sessions/workflow (use --keep to retain)');
        }
        await redis.quit();
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} E2E: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ e2e crashed:', e.message); process.exit(1); });
