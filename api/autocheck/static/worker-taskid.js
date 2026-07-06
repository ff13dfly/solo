/**
 * 模块: Worker Thread 消息关联 ID 检测
 *
 * 检测目标：使用 worker_threads 的 logic 文件，onMessage 处理器必须用唯一 taskId
 *           关联请求与响应，防止并发场景下消息错发（cross-task message routing race）。
 *
 * 背景：issue_20260425 根因 —— Worker 池 onMessage 只按 msg.type 匹配，
 *       同一 Worker 上多个 task 的监听器同时存在时，先到的结果会错发给后注册的 task。
 *
 * 规则：
 *   ✅ 正确：onMessage 同时检查 msg.taskId（或 msg.id / msg.correlationId）
 *      if (!msg || msg.taskId !== taskId) return;
 *   ❌ 错误：onMessage 只按 msg.type 匹配
 *      if (msg.type === 'HASH_RESULT') { resolve(msg.payload); }
 *
 * 豁免：文件名包含 worker（worker.js 本身是子线程，不是调度方）
 */

const fs = require('fs');
const path = require('path');

// 关联 ID 字段常见命名
const CORRELATION_PATTERNS = [
    /msg\.(taskId|id|correlationId|requestId|seqId)\b/,
    /message\.(taskId|id|correlationId|requestId|seqId)\b/,
];

function check(servicePath, results) {
    const logicPath = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicPath)) return;

    const files = fs.readdirSync(logicPath).filter(f => f.endsWith('.js'));

    files.forEach(file => {
        const baseName = path.basename(file, '.js').toLowerCase();
        // 豁免 worker.js 本身（子线程侧，不需要关联 ID 检查）
        if (baseName === 'worker' || baseName.endsWith('_worker')) return;

        const content = fs.readFileSync(path.join(logicPath, file), 'utf-8');

        // 跳过没有使用 worker_threads 的文件
        if (!content.includes('worker_threads') && !content.includes('new Worker(')) return;

        // 检查是否存在 onMessage / on('message') 处理器
        const hasOnMessage = /\.on\s*\(\s*['"]message['"]\s*,/.test(content) ||
                             /onMessage\s*=/.test(content);
        if (!hasOnMessage) return;

        // 检查是否有关联 ID 校验
        const hasCorrelation = CORRELATION_PATTERNS.some(p => p.test(content));

        if (!hasCorrelation) {
            results.errors.push(
                `❌ [WorkerRace] logic/${file}: 使用了 Worker 线程但 onMessage 缺少关联 ID 校验 (taskId/correlationId)。` +
                `并发场景下多个 task 共享同一 Worker 时，消息可能错发给其他 task（见 issue_20260425）。` +
                `修复：postMessage 时附带唯一 taskId，onMessage 里先验证 msg.taskId === taskId。`
            );
        } else {
            results.passed.push(`✅ [WorkerRace] logic/${file}: Worker onMessage 包含关联 ID 校验`);
        }
    });
}

module.exports = { check };
