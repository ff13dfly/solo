/**
 * 模块: Events 声明检查
 *
 * 检测目标：
 *   1. handlers/events.js 存在
 *   2. 导出 { emits: Array, subscribes: Array }（结构正确）
 *   3. 每个 emit 条目都有 stream 和 type 字段
 *   4. index.js 或 handlers/jsonrpc.js 中注册了 'events' 方法
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const eventsPath = path.join(servicePath, 'handlers/events.js');

    // ── 1. 文件存在 ──────────────────────────────────────────────────────────
    if (!fs.existsSync(eventsPath)) {
        results.errors.push(`❌ [events] handlers/events.js 缺失 — 新服务必须声明事件边界`);
        return;
    }

    // ── 2. 结构正确 ──────────────────────────────────────────────────────────
    let declaration;
    try {
        declaration = require(eventsPath);
    } catch (e) {
        results.errors.push(`❌ [events] handlers/events.js require 失败: ${e.message}`);
        return;
    }

    if (!declaration || typeof declaration !== 'object') {
        results.errors.push(`❌ [events] handlers/events.js 必须导出对象 { emits, subscribes }`);
        return;
    }

    const { emits, subscribes } = declaration;

    if (!Array.isArray(emits)) {
        results.errors.push(`❌ [events] handlers/events.js: emits 必须是数组（当前: ${typeof emits}）`);
        return;
    }
    if (!Array.isArray(subscribes)) {
        results.errors.push(`❌ [events] handlers/events.js: subscribes 必须是数组（当前: ${typeof subscribes}）`);
        return;
    }

    results.passed.push(`✅ [events] handlers/events.js 存在且结构正确（${emits.length} emit, ${subscribes.length} subscribe）`);

    // ── 3. 每个 emit 条目有 stream + type ────────────────────────────────────
    const incomplete = emits.filter(e => !e.stream || !e.type);
    if (incomplete.length > 0) {
        results.warnings.push(
            `⚠️  [events] ${incomplete.length} 个 emit 条目缺少 stream 或 type 字段（流量溯源依赖这两个字段）`
        );
    } else if (emits.length > 0) {
        results.passed.push(`✅ [events] 所有 emit 条目均有 stream + type 声明`);
    }

    // ── 4. index.js / handlers/jsonrpc.js 中注册了 'events' ─────────────────
    const candidates = [
        path.join(servicePath, 'index.js'),
        path.join(servicePath, 'handlers/jsonrpc.js'),
    ];
    const registered = candidates.some(f => {
        if (!fs.existsSync(f)) return false;
        return fs.readFileSync(f, 'utf8').includes("'events'");
    });

    if (!registered) {
        results.warnings.push(
            `⚠️  [events] 未在 index.js 或 handlers/jsonrpc.js 中找到 'events' 方法注册 — ` +
            `Router 握手时无法拉取事件声明`
        );
    } else {
        results.passed.push(`✅ [events] 'events' 方法已注册到 jsonrpc 路由`);
    }
}

module.exports = { check };
