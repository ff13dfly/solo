/**
 * run-portal demo seeder — injects SAFE, removable fixtures into the dev redis so the
 * portal/system reliability pages (Agent Nexus → Control / Event Bus) render POPULATED:
 *   - an admin session (auth bypass, mirrors the e2e harness)
 *   - a STALLED run        → the Re-drive / RETRY button (orchestrator.run.retry)
 *   - a FAILED run + Saga `compensation` → the rollback table in the run's expanded detail
 *   - an `ops.run_stalled` notification on the 'ops' inbox → the Ops alerts panel
 *
 * Why it's safe on the LIVE dev stack: the runs are terminal/STALLED (not RUNNING), so the
 * live worker's stall scanner — which only scans RUNNING — never touches them; the queue is
 * untouched; the notification has no consumer; the session is auth-only. Everything is
 * `vis-`-prefixed and `--clean` removes it. NEVER seeds a workflow (so the matcher is inert).
 *
 *   node seed.js          # seed     (REDIS_URL env, default redis://localhost:6699)
 *   node seed.js --clean  # teardown
 */
const path = require('path');
const REPO = path.join(__dirname, '..', '..', '..');           // <repo>/.claude/skills/run-portal → <repo>
const { createClient } = require(path.join(REPO, 'api', 'node_modules', 'redis'));

const URL = process.env.REDIS_URL || 'redis://localhost:6699';
const TOKEN = 'vis-admin-token';
const RUN_IDX = 'ORCHESTRATOR:RUN_INDEX';
const STALL = 'vis-stall-1', FAIL = 'vis-fail-1', OPS = 'vis-ops-1';

(async () => {
  const r = createClient({ url: URL });
  await r.connect();
  const now = Date.now();

  if (process.argv.includes('--clean')) {
    await r.del(`session:${TOKEN}`, `ORCHESTRATOR:RUN:${STALL}`, `ORCHESTRATOR:RUN:${FAIL}`, `NOTIFICATION:MSG:${OPS}`);
    await r.sRem(RUN_IDX, STALL); await r.sRem(RUN_IDX, FAIL);
    await r.zRem('NOTIFICATION:INBOX:ops', OPS);
    console.log('✓ run-portal demo fixtures removed');
    await r.quit(); return;
  }

  await r.set(`session:${TOKEN}`, JSON.stringify({ uid: 'vis-admin', username: 'vis-admin', role: 'admin', permit: { allow_all: true, services: {} } }), { EX: 4 * 3600 });

  await r.json.set(`ORCHESTRATOR:RUN:${STALL}`, '$', {
    id: STALL, workflowId: 'wf-demo-charge', status: 'STALLED', triggerSource: 'event',
    startedAt: now - 700000, stalledAt: now - 60000, attempts: 1, committedSteps: ['charge'],
  });
  await r.sAdd(RUN_IDX, STALL);

  await r.json.set(`ORCHESTRATOR:RUN:${FAIL}`, '$', {
    id: FAIL, workflowId: 'wf-demo-saga', status: 'FAILED', triggerSource: 'event',
    startedAt: now - 120000, failedAt: now - 110000, attempts: 1,
    failedStep: 'ship', lastError: 'collection.payment.settle: payment not found',
    cleanupManifest: [{ id: 'charge', method: 'collection.payment.record', result_summary: 'amount 100 CNY', compensate: 'reverse_charge' }],
    compensation: { ran: true, failed: false, entries: [{ forStep: 'charge', compensate: 'reverse_charge', method: 'collection.payment.record', status: 'success' }] },
  });
  await r.sAdd(RUN_IDX, FAIL);

  await r.set(`NOTIFICATION:MSG:${OPS}`, JSON.stringify({
    id: OPS, targetId: 'ops', type: 'ops.run_stalled',
    payload: { runId: STALL, workflowId: 'wf-demo-charge', committedSteps: ['charge'], hint: 'worker died mid-run. Re-drive idempotency-safely via orchestrator.run.retry.' },
    ref: `run_stalled:${STALL}`, status: 'unread', createdAt: now - 55000,
  }));
  await r.zAdd('NOTIFICATION:INBOX:ops', { score: now - 55000, value: OPS });

  console.log(`✓ seeded: session ${TOKEN} · runs ${STALL}(STALLED)/${FAIL}(FAILED+comp) · ops alert ${OPS}`);
  await r.quit();
})().catch(e => { console.error('seed error:', e.message); process.exit(1); });
