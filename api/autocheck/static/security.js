/**
 * 模块 5: 安全合规检查
 * 检测目标：验证 Level 3 Security 中间件和公开方法白名单（principles.md §3）
 * 必须白名单：ping, methods, entities（Router 发现机制依赖）
 * 必须白名单路由：/auth/seed, /auth/verify（Z-Handshake 握手）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const authPath = path.join(servicePath, 'handlers/auth.js');

    if (!fs.existsSync(authPath)) {
        results.warnings.push(`⚠️ [安全] 缺少 handlers/auth.js (无 Level 3 安全)`);
        return;
    }

    results.passed.push(`✅ [安全] handlers/auth.js 存在`);
    const authContent = fs.readFileSync(authPath, 'utf-8');

    // 若 auth.js 委托给 library/auth（createAuthHandlers），则从 lib 文件读取内容验证
    const isLibDelegate = authContent.includes('library/auth') || authContent.includes('createAuthHandlers');
    // library/auth.js sits at api/library — resolve it for services at any depth under
    // api/ (core/apps/* are 2-deep, api/sample is 1-deep). Try each candidate.
    const libCandidates = ['../../../library/auth.js', '../../library/auth.js', '../library/auth.js']
        .map(rel => path.join(servicePath, rel));
    const found = libCandidates.find(p => fs.existsSync(p));
    const libContent = isLibDelegate
        ? (found ? fs.readFileSync(found, 'utf-8') : authContent)
        : authContent;

    // 检查公开方法白名单
    const requiredPublicMethods = ['ping', 'methods', 'entities'];
    for (const method of requiredPublicMethods) {
        if (libContent.includes(`'${method}'`) || libContent.includes(`"${method}"`)) {
            results.passed.push(`✅ [安全] 已白名单系统方法: ${method}`);
        } else {
            results.errors.push(`❌ [安全] 未白名单系统方法: ${method}`);
        }
    }

    // 检查 handshake 路由白名单（接受字面量或 startsWith('/auth/') 模式）
    const hasHandshakeBypass = libContent.includes('/auth/seed') ||
                               libContent.includes("startsWith('/auth/')") ||
                               libContent.includes('startsWith("/auth/")');
    if (hasHandshakeBypass) {
        results.passed.push(`✅ [安全] Handshake 路由已白名单`);
    } else {
        results.errors.push(`❌ [安全] 未白名单 handshake 路由 (/auth/seed, /auth/verify)`);
    }

    // 检查是否引入了禁用的加密库 (强制使用 library/crypto)
    const logicPath = path.join(servicePath, 'logic');
    if (fs.existsSync(logicPath)) {
        const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));
        const forbiddenPats = [
            { name: 'bcrypt', pat: /require\(['"]bcrypt['"]\)/ },
            { name: 'crypto-js', pat: /require\(['"]crypto-js['"]\)/ },
            { name: 'sha256', pat: /require\(['"]sha256['"]\)/ },
            { name: 'md5', pat: /require\(['"]md5['"]\)/ }
        ];

        files.forEach(file => {
            const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');
            forbiddenPats.forEach(lib => {
                if (lib.pat.test(content)) {
                    results.warnings.push(`⚠️ [安全] 发现禁用加密库 "${lib.name}" 在 ${file} 中。请统一使用 "library/crypto"。`);
                }
            });
        });

        // ── isAdmin 判断模式检查 ───────────────────────────────────────────
        // Router 向下游透传 permit 为字符串 'admin'|'user'，不是原始 permit 对象。
        // 服务使用 req.user = payload.user（uid 字符串）时：
        //   ✅ 正确：req.permit === 'admin'
        //   ❌ 错误：req.user?.permit?.allow_all  （req.user 是字符串，无 permit 属性）
        //   ❌ 错误：req.user.permit.allow_all     （同上）
        // 服务使用 req.user = payload（全对象）时：
        //   ✅ 正确：req.user?.permit === 'admin'
        const indexPath = path.join(servicePath, 'index.js');
        if (fs.existsSync(indexPath)) {
            const indexContent = fs.readFileSync(indexPath, 'utf-8');
            const authContent2 = fs.readFileSync(authPath, 'utf-8');
            // 判断 auth 模式：payload.user（uid 字符串）还是 payload（全对象）
            const isUidPattern = /req\.user\s*=\s*payload\.user/.test(authContent2);

            const brokenPatterns = [
                { pat: /req\.user\??\s*\.\s*permit\??\s*\.\s*allow_all/, label: 'req.user?.permit?.allow_all' },
                { pat: /req\.user\s*&&\s*req\.user\s*\.\s*permit\s*&&\s*req\.user\s*\.\s*permit\s*\.\s*allow_all/, label: 'req.user.permit.allow_all' },
            ];

            let hasAdminCheck = false;
            // 只检查非注释行
            const indexLines = indexContent.split('\n');
            const indexCodeOnly = indexLines
                .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
                .join('\n');

            brokenPatterns.forEach(({ pat, label }) => {
                if (pat.test(indexCodeOnly)) {
                    hasAdminCheck = true;
                    results.errors.push(
                        `❌ [isAdmin] index.js 使用错误的 admin 判断 \`${label}\`。` +
                        (isUidPattern
                            ? `此服务 auth 模式为 payload.user（uid 字符串），应改为 \`req.permit === 'admin'\``
                            : `应改为 \`req.user?.permit === 'admin'\``)
                    );
                }
            });

            if (!hasAdminCheck && /isAdmin/.test(indexContent)) {
                results.passed.push(`✅ [isAdmin] admin 判断模式正确`);
            }
        }

        // 检查跨服务直接 HTTP 调用（架构规范：微服务间只能通过 Router 或 _tasks 通信）
        // 豁免：ERP 服务需要直接调用用友 T+ 外部 API；tplus_client.js、webhook 等明确外部集成文件
        const serviceName = path.basename(servicePath);
        const EXEMPT_SERVICES = ['erp', 'gateway'];  // 这些服务允许直接外部 HTTP（有明确外部依赖）
        const EXEMPT_FILES = ['tplus', 'webhook', 'client', 'gateway', 'proxy'];  // 文件名含这些词豁免

        // 匹配 HTTP 调用模式（排除注释行）
        const HTTP_PATTERNS = [
            { name: 'fetch()',   pat: /\bfetch\s*\(/g },
            { name: 'axios',     pat: /\baxios\s*[.(]/g },
            { name: 'got()',     pat: /\bgot\s*\(/g },
            { name: 'superagent', pat: /\bsuperagent\b/g },
            { name: 'node-fetch', pat: /require\(['"]node-fetch['"]\)/g },
            { name: 'http.request', pat: /\bhttp(s?)\s*\.\s*request\s*\(/g },
        ];

        if (!EXEMPT_SERVICES.includes(serviceName)) {
            files.forEach(file => {
                // 豁免：文件名含豁免关键词
                const baseName = path.basename(file, '.js').toLowerCase();
                if (EXEMPT_FILES.some(kw => baseName.includes(kw))) return;

                const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');
                // 豁免：文件通过 config.routerUrl 调用 Router（正确的架构模式）
                if (/config\.routerUrl/.test(content) && /http\.request/.test(content)) return;
                const lines = content.split('\n');

                HTTP_PATTERNS.forEach(({ name, pat }) => {
                    pat.lastIndex = 0;
                    let m;
                    while ((m = pat.exec(content)) !== null) {
                        const lineIdx = content.slice(0, m.index).split('\n').length - 1;
                        const lineText = lines[lineIdx] || '';
                        // 豁免：注释行
                        if (lineText.trimStart().startsWith('//') || lineText.trimStart().startsWith('*')) continue;
                        results.errors.push(
                            `❌ [架构] logic/${file}:${lineIdx + 1}: 发现直接 HTTP 调用 (${name})，` +
                            `微服务间通信必须通过 Router 或 _tasks，禁止直接互调（CLAUDE.md 架构约束）`
                        );
                    }
                });
            });
        }
    }
}

module.exports = { check };
