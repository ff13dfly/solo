/**
 * 34 · 本地鉴权旁路加固守护(library/auth.js).
 *
 * 直连服务端口(**绕过 Router**)+ 伪造 `Host: localhost` + **无 Router token** → 必须被拒.
 * 守护两点加固,防回归:
 *   ① 旁路默认关闭(只在 AUTH_ALLOW_LOCAL_BYPASS=1 时才允许;harness 不设它)
 *   ② 只信真实 socket IP,不信可伪造的 Host 头(`Host: localhost` 不再让 isLocal 成立)
 * 若有人把旁路改回默认开 / 重新耦合 debug / 重新信 Host 头,本套即红.
 */
const http = require('http');
const { read } = require('../lib/context');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

function directPost(port, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const req = http.request(
            { host: '127.0.0.1', port, path: '/jsonrpc', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...headers } },
            (res) => {
                let d = ''; res.on('data', (c) => (d += c));
                res.on('end', () => { let b; try { b = JSON.parse(d); } catch { b = { _raw: d }; } resolve({ status: res.statusCode, body: b }); });
            });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(raw); req.end();
    });
}

gate('34 · local-auth-bypass hardening', () => {
    // 非 public 的变更/读取方法(public 方法本就免鉴权,不能用来测).
    const TARGETS = [
        ['collection', 'collection.payment.record', { amount: 1, currency: 'CNY' }],
        ['planner',    'planner.todo.create',       { name: 'x', content: 'y' }],
        ['storage',    'storage.asset.get',         { id: 'nope' }],
    ];

    for (const [svc, method, params] of TARGETS) {
        test(`直连 ${svc}(绕过 Router)+ Host: localhost + 无 token → 被拒`, async () => {
            const port = read().services[svc];
            expect(port).toBeTruthy();

            const res = await directPost(port, { jsonrpc: '2.0', id: 1, method, params }, { Host: 'localhost' });

            // 必须被鉴权挡:HTTP 401/403,或 jsonrpc auth error;绝不能成功执行.
            const rejected = res.status === 401 || res.status === 403 || Boolean(res.body && res.body.error);
            expect(rejected).toBe(true);
            expect(res.body && res.body.result).toBeFalsy();   // 没有真执行
        });
    }
});
