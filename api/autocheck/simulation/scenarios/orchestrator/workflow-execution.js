/**
 * 场景: Orchestrator workflow CRUD + 执行引擎
 *
 * 测试 1 — 并发创建同 ID workflow（TOCTOU）
 *   N 个请求同时 create 同一个 workflowId，只有 1 个应成功。
 *
 * 测试 2 — 变量解析正确性
 *   workflow 的 step.params 包含 $input.x / $step.s1.result.y，
 *   通过 mock Router 捕获实际发出的 params，核对是否正确替换。
 *
 * 测试 3 — ignore_error 容错行为
 *   第 1 步 mock 返回错误，ignore_error=true，验证 workflow 继续执行第 2 步并返回 completed。
 *
 * 测试 4 — 并发执行 context 隔离
 *   N 个不同 input 的 workflow 同时 run，每个 trace 里的 params 必须对应自己的 input。
 */

const http = require('http');
const path = require('path');

// ─── Mock Router HTTP Server ───────────────────────────────────────────────
// 接受任意 JSON-RPC 请求，按预设规则返回结果
class MockRouter {
    constructor() {
        this.port = null;
        this.server = null;
        this.handler = (method, params) => ({ result: { echo: params } });
    }

    setHandler(fn) { this.handler = fn; }

    start() {
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                let body = '';
                req.on('data', c => body += c);
                req.on('end', async () => {
                    try {
                        const { method, params, id } = JSON.parse(body);
                        const result = await this.handler(method, params);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', result, id }));
                    } catch (e) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: 1 }));
                    }
                });
            });
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve(`http://127.0.0.1:${this.port}`);
            });
        });
    }

    stop() {
        return new Promise(resolve => this.server?.close(resolve));
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function loadLogic(redis, routerUrl) {
    const idPath = path.join(__dirname, '../../../../core/orchestrator/logic/index');
    delete require.cache[require.resolve(idPath)];
    return require(idPath)(redis, { serviceName: 'orchestrator', routerUrl });
}

function makeWorkflow(id, steps) {
    return {
        id,
        category: 'test',
        name:     `Test ${id}`,
        desc:     'simulation test workflow',
        steps,
    };
}

// ─── 测试 1: 并发创建同 ID TOCTOU ─────────────────────────────────────────
async function testCreateTOCTOU(redis) {
    console.log('\n[Test 1] Concurrent create same ID (TOCTOU)');
    const logic = loadLogic(redis, 'http://localhost:1');
    const wfId  = 'wf_dup_test';
    const N     = 8;

    const results = await Promise.allSettled(
        Array.from({ length: N }, () =>
            logic.workflow.create(makeWorkflow(wfId, [{
                id: 's1', service: 'ping', method: 'ping', params: {}
            }]))
        )
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const ok = succeeded.length === 1;

    console.log(`  Attempts: ${N}  Succeeded: ${succeeded.length}`);
    if (ok) {
        console.log('  ✅ Only 1 create succeeded');
    } else {
        console.log(`  ❌ Expected 1, got ${succeeded.length} — TOCTOU race on workflow ID`);
    }
    return ok;
}

// ─── 测试 2: 变量解析正确性 ────────────────────────────────────────────────
async function testVariableResolution(redis) {
    console.log('\n[Test 2] Variable resolution ($input / $step.result)');

    const mock = new MockRouter();
    const captured = {};

    mock.setHandler((method, params) => {
        captured[method] = params;
        if (method === 'svc.step1') return { value: 42, label: 'hello' };
        if (method === 'svc.step2') return { ok: true };
        return {};
    });

    const routerUrl = await mock.start();
    const logic = loadLogic(redis, routerUrl);

    const wfId = 'wf_vartest';
    await logic.workflow.create(makeWorkflow(wfId, [
        { id: 's1', service: 'svc', method: 'svc.step1', params: { x: '$input.x' } },
        { id: 's2', service: 'svc', method: 'svc.step2', params: {
            fromInput: '$input.x',
            fromStep:  '$step.s1.result.value',
        }},
    ]));

    const result = await logic.runner.run({ workflowId: wfId, input: { x: 99 } });

    await mock.stop();

    const s1params = captured['svc.step1'];
    const s2params = captured['svc.step2'];

    const ok =
        result.status === 'completed' &&
        s1params?.x === 99 &&
        s2params?.fromInput === 99 &&
        s2params?.fromStep  === 42;

    console.log(`  Workflow status: ${result.status}`);
    console.log(`  s1 params.x=${s1params?.x} (expected 99)`);
    console.log(`  s2 fromInput=${s2params?.fromInput} (expected 99), fromStep=${s2params?.fromStep} (expected 42)`);

    if (ok) {
        console.log('  ✅ Variables resolved correctly');
    } else {
        console.log('  ❌ Variable resolution mismatch');
    }
    return ok;
}

// ─── 测试 3: ignore_error 容错行为 ────────────────────────────────────────
async function testIgnoreError(redis) {
    console.log('\n[Test 3] ignore_error — workflow continues on step failure');

    const mock = new MockRouter();
    mock.setHandler((method) => {
        if (method === 'svc.fail') throw new Error('intentional_failure');
        return { ok: true };
    });

    const routerUrl = await mock.start();
    const logic = loadLogic(redis, routerUrl);

    const wfId = 'wf_ignore_err';
    await logic.workflow.create(makeWorkflow(wfId, [
        { id: 's1', service: 'svc', method: 'svc.fail', params: {}, ignore_error: true },
        { id: 's2', service: 'svc', method: 'svc.ok',   params: {} },
    ]));

    const result = await logic.runner.run({ workflowId: wfId, input: {} });
    await mock.stop();

    const s1trace = result.trace?.find(t => t.id === 's1');
    const s2trace = result.trace?.find(t => t.id === 's2');

    const ok =
        result.status === 'completed' &&
        s1trace?.status === 'failed' &&
        s2trace?.status === 'success';

    console.log(`  Workflow status: ${result.status}`);
    console.log(`  s1 status: ${s1trace?.status}, s2 status: ${s2trace?.status}`);
    if (ok) {
        console.log('  ✅ Workflow completed despite step failure');
    } else {
        console.log('  ❌ ignore_error not working correctly');
    }
    return ok;
}

// ─── 测试 4: 并发执行 context 隔离 ────────────────────────────────────────
async function testConcurrentContextIsolation(redis) {
    console.log('\n[Test 4] Concurrent execution — context isolation');
    const N = 10;

    const mock = new MockRouter();
    const received = [];
    mock.setHandler((method, params) => {
        received.push({ method, params });
        return { ok: true };
    });

    const routerUrl = await mock.start();
    const logic = loadLogic(redis, routerUrl);

    // 创建一个 workflow，step 把 $input.id echo 出去
    const wfId = 'wf_context_iso';
    await logic.workflow.create(makeWorkflow(wfId, [
        { id: 's1', service: 'svc', method: 'svc.echo', params: { id: '$input.id' } },
    ]));

    // N 个不同 input 并发执行
    const inputs = Array.from({ length: N }, (_, i) => ({ id: `run_${i}` }));
    const results = await Promise.all(
        inputs.map(input => logic.runner.run({ workflowId: wfId, input }))
    );

    await mock.stop();

    // 核对每个 run 的 trace：params.id 必须对应自己的 input.id
    const drifts = [];
    results.forEach((r, i) => {
        const s1 = r.trace?.find(t => t.id === 's1');
        if (s1?.params?.id !== inputs[i].id) {
            drifts.push(`run_${i}: expected id=${inputs[i].id}, got id=${s1?.params?.id}`);
        }
    });

    const ok = drifts.length === 0;
    console.log(`  Concurrent runs: ${N}  Drifts: ${drifts.length}`);
    if (ok) {
        console.log('  ✅ All contexts correctly isolated');
    } else {
        drifts.forEach(d => console.log(`  ❌ ${d}`));
    }
    return ok;
}

// ─── 入口 ──────────────────────────────────────────────────────────────────
async function run(redis) {
    console.log('\n═══ Orchestrator Service Simulation ═══');

    const r1 = await testCreateTOCTOU(redis);
    await redis.flushDb();

    const r2 = await testVariableResolution(redis);
    await redis.flushDb();

    const r3 = await testIgnoreError(redis);
    await redis.flushDb();

    const r4 = await testConcurrentContextIsolation(redis);

    console.log('\n═══ Summary ═══');
    [
        ['Concurrent create same ID (TOCTOU)',         r1],
        ['Variable resolution ($input / $step.result)', r2],
        ['ignore_error step continues workflow',        r3],
        ['Concurrent execution context isolation',      r4],
    ].forEach(([label, ok]) =>
        console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    );
    console.log('');

    return r1 && r2 && r3 && r4;
}

module.exports = { run };
