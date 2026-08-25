/**
 * 假 Router —— 一个只会说 JSON-RPC 的小 HTTP 服务。
 *
 * @why 不打真栈：这套用例要验的是**扩展侧的接线**（kit 在真 service worker 里跑起来没有、
 *      队列是不是真的落盘、SW 被杀之后还在不在），这些跟后端是谁无关。用假 Router 换来
 *      三件事：① 无需先 `deploy/run.sh`，任何机器上 clone 完就能跑；② 能精确编排错误码
 *      （永久失败 / 限流 / 会话过期），真栈很难稳定造出来；③ 快——真 Router 不可达时
 *      rpc.js 会老老实实退避重试约 37 秒，一条用例就超时了。
 *
 * 打真 Router 的**契约层** e2e 是另一件事（验 user.login.request 还回不回 salt、
 * ingress 还去不去重），见 README「还没做的」。
 */
import http from 'node:http';

export async function startFakeRouter() {
    const calls = [];
    /** 默认一律成功。用 reply() 换成别的剧本。 */
    let handler = () => ({ result: { ok: true } });

    const server = http.createServer((req, res) => {
        if (req.method === 'OPTIONS') {          // host_permissions 下通常不会有预检，兜一下
            res.writeHead(204, cors()); res.end(); return;
        }
        // 一张普通网页，给 content script 用例当注入目标。
        // @why 挂在这个服务上而不是另起一个：manifest 的 matches 是 `http://127.0.0.1/*`
        //      （match pattern 表达不了端口），同一个 host 就够，省掉第二个端口和它的清理。
        if (req.method === 'GET' && req.url.startsWith('/page')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors() });
            res.end('<!doctype html><meta charset="utf-8"><title>假商品页</title>'
                + '<h1>一件很贵的东西</h1><p id="body">正文</p>');
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let payload = {};
            try { payload = JSON.parse(body); } catch { /* 记成空调用即可 */ }
            calls.push({
                method: payload.method,
                params: payload.params,
                auth: req.headers.authorization || null,
            });
            const out = handler(payload, calls.length) || {};
            res.writeHead(200, { 'Content-Type': 'application/json', ...cors() });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id ?? 1, ...out }));
        });
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    return {
        // sample 的 manifest 已把 127.0.0.1 写进 host_permissions，不会弹授权框。
        url: `http://127.0.0.1:${port}/jsonrpc`,
        /** 一张会被 content script 注入的普通网页（同 host，见上）。 */
        pageUrl: `http://127.0.0.1:${port}/page`,
        calls,
        /** 换剧本：fn(payload, nth) → { result } | { error: { code, message } } */
        reply(fn) { handler = fn; },
        methodsSeen: () => calls.map((c) => c.method),
        // 🔴 `closeAllConnections()` 不能省：`server.close()` 只是停止接受新连接，
        //    **等已有的 keep-alive 连接自己结束**——而 Chrome 会把它们留着。症状是
        //    fixture 拆解阶段挂死到用例超时（60s），报错指向被测用例，跟它毫无关系。
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
