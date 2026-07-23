/**
 * library/guide.js — fleet-standard `guide` 方法的统一实现
 *
 * 背景（docs/feedback/ai-agent-self-describing-api.md）：introspection 说得出
 * "有什么方法"，说不出"任务怎么做"（先传图拿 assetId 再 create 挂上，按 sku 幂等…）。
 * guide 是第四个 fleet-standard 系统方法，与 ping/methods/entities/events 并列，
 * 把服务目录下的 GUIDE.md 原样返回——内容与代码同目录、同一次 commit 修改，
 * 机制上杜绝外挂文档过时。
 *
 * 用法（各服务 index.js 的 handlers 表加一行）：
 *   'guide': () => require('../../library/guide').readGuide('storage', __dirname),
 *
 * 双运行时解析（镜像 library/ports.js 的 __SOLO_PORTS__ 模式）：
 *   1. bundle：esbuild 把 .md 打成 empty（deploy/build.sh --loader:.md=empty），
 *      文件读不到——gen-entry.js 构建时已把各服务 GUIDE.md 内容播进
 *      global.__SOLO_GUIDES__，优先取它。
 *   2. from-source（monolith / 单服务）：直接读 serviceDir 下的 GUIDE.md。
 *
 * GUIDE.md 不存在 → 明确返回 { available: false }，不抛错（未提供 guide 是
 * 合法状态，不是故障）。
 */
const fs = require('fs');
const path = require('path');

function readGuide(serviceName, serviceDir) {
    const embedded = global.__SOLO_GUIDES__ && global.__SOLO_GUIDES__[serviceName];
    if (typeof embedded === 'string') {
        return { available: true, format: 'markdown', content: embedded };
    }
    try {
        const content = fs.readFileSync(path.join(serviceDir, 'GUIDE.md'), 'utf8');
        return { available: true, format: 'markdown', content };
    } catch (_) {
        return { available: false, message: `Service "${serviceName}" does not provide a GUIDE.md` };
    }
}

module.exports = { readGuide };
