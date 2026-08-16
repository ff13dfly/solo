/**
 * 模块: 监听网卡检查 (Bind Address Check)
 *
 * 检测目标：服务的 `app.listen(...)` 是否把 host 参数接到 `library/ports.js` 的
 *          `bindAddr('<service>')` 上。
 *
 * @why `app.listen(PORT, cb)` —— 不传 host —— 让 Node 绑 `::` / 0.0.0.0，也就是
 *      **这台机器的每一个网卡**。本机开发时完全无感；机器一旦有公网网卡，这个服务
 *      当场对全网可达，而项目里没有任何地方能表达"这个服务不该对外"。
 *      2026-08-14 一个 runner 部署踩到：两个私有服务只想暴露其中一个，最后只能靠
 *      机器上的 nftables 规则兜——那份知识不在仓库里、`nft flush ruleset` 一条命令
 *      静默解除、加新服务时也没有任何东西提醒你回去改防火墙。
 *      （docs/feedback/run-sh-no-per-app-env.md）
 *
 *      接上 bindAddr() 后，"哪个服务对外"变成 `.env` / `deploy/services.json` 里
 *      声明、跟着 git 走的事实：
 *        BIND_ADDR=127.0.0.1  +  <NAME>_BIND_ADDR=0.0.0.0 单独放行
 *
 * 不改变默认行为：两个变量都不设时 bindAddr() 返回 undefined，而
 * `listen(port, undefined, cb)` 与 `listen(port, cb)` 完全等价（已实测），
 * 所以接上它对现有部署零影响——它只是把"能锁"这个能力加进来。
 *
 * 级别：WARN。存量服务（含各派生项目）普遍是老写法，设成 ERROR 会一次炸一片；
 * autocheck 已挂 PostToolUse 钩子，WARN 每次改完都会呈现给作者。
 */

const fs = require('fs');
const path = require('path');

// `.listen(` 的调用行；变量名不限（app / server / httpServer 都见过）
const LISTEN_RE = /\.listen\s*\(/;
const LOOKAHEAD_LINES = 3;   // 允许参数跨行写

function check(servicePath, results) {
    const indexPath = path.join(servicePath, 'index.js');
    // 无 index.js 的目录不是标准可路由服务（structure 检查已把关），跳过。
    if (!fs.existsSync(indexPath)) return;

    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.split('\n');
    const serviceName = path.basename(servicePath);

    const offenders = [];
    lines.forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (!LISTEN_RE.test(line)) return;
        // WebSocket / redis 客户端等也有 .listen 的场景很少，但真出现时
        // 作者可以像别的规则一样用 `// SAFE:` 标注豁免。
        if (line.includes('// SAFE:')) return;

        const window = lines.slice(i, Math.min(lines.length, i + 1 + LOOKAHEAD_LINES)).join('\n');
        if (!window.includes('bindAddr')) {
            offenders.push({ line: i + 1, text: line.trim() });
        }
    });

    if (offenders.length === 0) {
        // 只有真的存在 listen 调用时才报 PASS，避免给纯库目录发无意义的绿灯
        if (LISTEN_RE.test(content)) {
            results.passed.push(`✅ [bind-addr] listen 已接 bindAddr()，监听网卡可经 BIND_ADDR 控制`);
        }
        return;
    }

    offenders.forEach(({ line, text }) => {
        results.warnings.push(
            `⚠️ [bind-addr] index.js:${line}: \`${text}\` 未传 host —— Node 会绑**所有网卡**，` +
            `机器一有公网 IP 这个服务就对外可达，且项目里无处表达"它不该对外"。\n` +
            `       改成: const { bindAddr } = require('<depth>/library/ports');  ` +
            `app.listen(PORT, bindAddr('${serviceName}'), () => { … })\n` +
            `       两个 env 都不设时 bindAddr() 返回 undefined，等价于现在的写法，零行为变化；` +
            `要锁就在 .env 设 BIND_ADDR=127.0.0.1，再用 ${serviceName.toUpperCase()}_BIND_ADDR 单独放行。`
        );
    });
}

module.exports = { check };
