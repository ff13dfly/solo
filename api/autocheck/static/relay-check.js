/**
 * 模块: library/relay.js 使用合规检查
 * 检测目标：防止服务自行实现 bot token 生命周期，违反 security.md §7.7
 *
 * 规则：
 * 1. [ERROR] 直接操作 RELAY:TOKEN Redis key — 只有 library/relay.js 才有权直接读写
 * 2. [ERROR] 直接调用 'user.token.refresh' — 该 RPC 只能从 relay.js 内部发起
 * 3. [WARN]  同时出现 routerUrl + Authorization 头构造，但未导入 relay.js
 *            — 说明服务正在自己封装 Router 认证调用，应改用 relay.call()
 *
 * 豁免：library/ 目录下的文件（relay.js 自身合法使用上述模式）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    for (const file of files) {
        const filePath = path.join(logicPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        const importsRelay = /require\(['"].*library\/relay['"]\)/.test(content);

        // ── 规则 1: 直接操作 RELAY:TOKEN Redis key ───────────────────────────
        const RELAY_KEY_PAT = /['"`]RELAY:TOKEN[:'"`]/g;
        let m;
        RELAY_KEY_PAT.lastIndex = 0;
        while ((m = RELAY_KEY_PAT.exec(content)) !== null) {
            const lineIdx = content.slice(0, m.index).split('\n').length - 1;
            const lineText = lines[lineIdx] || '';
            if (isComment(lineText)) continue;
            results.errors.push(
                `❌ [relay] logic/${file}:${lineIdx + 1}: 直接操作 RELAY:TOKEN Redis key。` +
                `token 生命周期必须通过 library/relay.js 管理（security.md §7.7）`
            );
        }

        // ── 规则 2: 直接调用 user.token.refresh ─────────────────────────────
        const REFRESH_PAT = /['"`]user\.token\.refresh['"`]/g;
        REFRESH_PAT.lastIndex = 0;
        while ((m = REFRESH_PAT.exec(content)) !== null) {
            const lineIdx = content.slice(0, m.index).split('\n').length - 1;
            const lineText = lines[lineIdx] || '';
            if (isComment(lineText)) continue;
            results.errors.push(
                `❌ [relay] logic/${file}:${lineIdx + 1}: 直接调用 user.token.refresh。` +
                `token 续签只能通过 relay.call() 触发，禁止业务代码直接调用（security.md §7.7）`
            );
        }

        // ── 规则 3: 自己构造 Authorization Bearer 头用于 Router 调用 ─────────
        if (!importsRelay) {
            const hasRouterUrl = /config\.routerUrl|routerUrl/.test(content);
            const hasBearerConstruct = /Authorization.*Bearer|Bearer.*\$\{/.test(content);
            if (hasRouterUrl && hasBearerConstruct) {
                results.warnings.push(
                    `⚠️ [relay] logic/${file}: 发现自建 Router 认证调用（routerUrl + Authorization: Bearer）。` +
                    `如需跨服务调用，应使用 relay.call()（library/relay.js）代替手动构造 token 请求`
                );
            }
        }
    }

    // 检查 index.js：若有 setServiceToken handler 但未引用 relay.js，给出提示
    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const hasSetServiceToken = /setServiceToken/.test(indexContent);
        const indexImportsRelay = /require\(['"].*library\/relay['"]\)/.test(indexContent);
        const logicImportsRelay = files.some(f => {
            const c = fs.readFileSync(path.join(logicPath, f), 'utf-8');
            return /require\(['"].*library\/relay['"]\)/.test(c);
        });

        if (hasSetServiceToken && !indexImportsRelay && !logicImportsRelay) {
            results.warnings.push(
                `⚠️ [relay] index.js 注册了 setServiceToken handler，但未找到 library/relay.js 的导入。` +
                `setServiceToken 应通过 relay.setToken() 写入 token，确认是否遗漏`
            );
        }
    }
}

function isComment(line) {
    const t = line.trimStart();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

module.exports = { check };
