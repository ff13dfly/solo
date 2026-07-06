/**
 * 模块 19: Ed25519 握手验证检查
 * 检测目标：确保微服务注册使用 Ed25519 签名方式（Z-Handshake 协议）
 * 
 * 必须使用：
 *   - tweetnacl.sign.detached.verify (Ed25519 签名验证)
 *   - bs58.decode (Base58 解码)
 *   - crypto.randomBytes (安全种子生成)
 * 
 * 禁止使用（将产生警告）：
 *   - crypto.createSign/createVerify (RSA/ECDSA)
 *   - crypto.createHmac (不适合握手)
 *   - jsonwebtoken (JWT 不符合 Z-Handshake)
 */

const fs = require('fs');
const path = require('path');

// 必须存在的 Ed25519 模式
const REQUIRED_PATTERNS = [
    {
        pattern: /tweetnacl\.sign\.detached\.verify/,
        name: 'tweetnacl.sign.detached.verify',
        desc: 'Ed25519 签名验证'
    },
    {
        pattern: /bs58\.decode/,
        name: 'bs58.decode',
        desc: 'Base58 解码'
    },
    {
        pattern: /crypto\.randomBytes/,
        name: 'crypto.randomBytes',
        desc: '安全随机种子'
    }
];

// 禁止使用的模式（产生警告）
const FORBIDDEN_PATTERNS = [
    {
        pattern: /crypto\.createSign|crypto\.createVerify/,
        name: 'crypto.createSign/Verify',
        desc: '通常用于 RSA/ECDSA，不符合 Ed25519 规范'
    },
    {
        pattern: /crypto\.createHmac/,
        name: 'crypto.createHmac',
        desc: 'HMAC 不适合握手认证'
    },
    {
        pattern: /require\(['"]jsonwebtoken['"]\)/,
        name: 'jsonwebtoken',
        desc: 'JWT 不符合 Z-Handshake 协议'
    }
];

function check(servicePath, results) {
    const authPath = path.join(servicePath, 'handlers/auth.js');
    
    // 检查 auth.js 是否存在
    if (!fs.existsSync(authPath)) {
        results.warnings.push(`⚠️ [Ed25519] 缺少 handlers/auth.js，无法验证握手实现`);
        return;
    }
    
    const authContent = fs.readFileSync(authPath, 'utf-8');

    // 若 auth.js 委托给 library/auth，则从 lib 读取内容验证
    const isLibDelegate = authContent.includes('library/auth') || authContent.includes('createAuthHandlers');
    // Resolve api/library/auth.js for services at any depth under api/ (core/apps are
    // 2-deep, api/sample is 1-deep).
    const libCandidates = ['../../../library/auth.js', '../../library/auth.js', '../library/auth.js']
        .map(rel => path.join(servicePath, rel));
    const libAuthPath = libCandidates.find(p => fs.existsSync(p)) || libCandidates[0];
    const libContent  = isLibDelegate && fs.existsSync(libAuthPath)
        ? fs.readFileSync(libAuthPath, 'utf-8')
        : authContent;
    // router-auth.js also holds bs58/tweetnacl - include it
    const routerAuthPath = path.join(path.dirname(libAuthPath), 'router-auth.js');
    const routerAuthContent = fs.existsSync(routerAuthPath) ? fs.readFileSync(routerAuthPath, 'utf-8') : '';
    const fullContent = libContent + '\n' + routerAuthContent;

    let hasAllRequired = true;

    // 检查必须存在的模式
    for (const { pattern, name, desc } of REQUIRED_PATTERNS) {
        if (pattern.test(fullContent)) {
            results.passed.push(`✅ [Ed25519] 使用 ${name} (${desc})`);
        } else {
            results.errors.push(`❌ [Ed25519] 缺少 ${name} (${desc})`);
            hasAllRequired = false;
        }
    }
    
    // 检查禁止使用的模式
    for (const { pattern, name, desc } of FORBIDDEN_PATTERNS) {
        if (pattern.test(fullContent)) {
            results.errors.push(`❌ [Ed25519] 检测到非规范实现: ${name} - ${desc}`);
        }
    }
    
    // 额外检查：Solana PublicKey（推荐但非必须）
    if (/PublicKey/.test(fullContent) && /@solana\/web3\.js/.test(fullContent)) {
        results.passed.push(`✅ [Ed25519] 使用 Solana PublicKey 格式`);
    } else if (/PublicKey/.test(fullContent)) {
        results.passed.push(`✅ [Ed25519] 使用 PublicKey 处理`);
    }

    // 检查握手端点实现
    if (/handleSeed/.test(fullContent) && /handleVerify/.test(fullContent)) {
        results.passed.push(`✅ [Ed25519] 握手端点已实现 (handleSeed, handleVerify)`);
    } else {
        results.warnings.push(`⚠️ [Ed25519] 未找到标准握手端点 (handleSeed/handleVerify)`);
    }
    
    // 检查 index.js 中是否实际挂载了路由
    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const hasSeedRoute = indexContent.includes("'/auth/seed'") || indexContent.includes('"/auth/seed"');
        const hasVerifyRoute = indexContent.includes("'/auth/verify'") || indexContent.includes('"/auth/verify"');
        
        if (hasSeedRoute && hasVerifyRoute) {
             results.passed.push(`✅ [Ed25519] 握手路由已挂载 (/auth/seed, /auth/verify)`);
        } else {
             if (!hasSeedRoute) results.errors.push(`❌ [Ed25519] index.js 缺少路由: /auth/seed`);
             if (!hasVerifyRoute) results.errors.push(`❌ [Ed25519] index.js 缺少路由: /auth/verify`);
        }
    }
    
    // 汇总
    if (hasAllRequired) {
        results.passed.push(`✅ [Ed25519] 握手验证符合 Z-Handshake 规范`);
    }
}

module.exports = { check };
