/**
 * system.report / system.report.list / system.report.update
 *
 * 外部 AI 主动反馈接口。用于收集：
 *   - 缺少的能力（missing_capability）
 *   - returns 字段不足（bad_returns）
 *   - 描述不清晰（unclear_description）
 *   - 调用链中断（chain_failure）
 *   - 其他（other）
 *
 * system.report        — public，无需 token，AI 随时提交
 * system.report.list   — 管理员查看收集到的报告（支持 type/status 过滤）
 * system.report.update — 管理员标记 triage 状态（NEW → REVIEWED / RESOLVED）
 *
 * 去重（2026-07-23，docs/feedback/ai-agent-self-describing-api.md 后续）：
 *   同一诉求（type|method|message 规范化后同指纹）重复提交 → count+1 而非新增条目。
 *   count 即「多少次任务撞过同一堵墙」——天然的优先级信号；措辞不同的相似诉求
 *   仍是独立条目，归并留给人工 triage（Portal → AI Reports）。
 *
 * triage 纪律见 docs/feedback/README.md：有价值的报告沉淀成该目录的 markdown
 * （判断类散文进 git），Redis 里只是工单原始数据（1000 条上限裁最旧）。
 */

const crypto = require('crypto');

const REPORT_KEY   = 'SYSTEM:AI:REPORT';      // Sorted Set，score = lastSeenAt
const FP_KEY       = 'SYSTEM:AI:REPORT:FP';   // Hash，fingerprint → JSON（去重索引）
const MAX_REPORTS  = 1000;                     // 最多保留最新 1000 条

const VALID_TYPES = new Set([
    'missing_capability',
    'bad_returns',
    'unclear_description',
    'chain_failure',
    'other',
]);

const VALID_STATUSES = new Set(['NEW', 'REVIEWED', 'RESOLVED']);

// 同指纹 = 同诉求：type + method + 规范化 message（措辞完全一致才合并）
function fingerprintOf(type, method, message) {
    const norm = message.trim().toLowerCase().replace(/\s+/g, ' ');
    return crypto.createHash('sha256')
        .update(`${type}|${method || ''}|${norm}`)
        .digest('hex').slice(0, 16);
}

// 旧格式条目（无 count/status/fingerprint，v1.1.11 前写入）读取时补默认值
function upgrade(report) {
    if (report.count === undefined) report.count = 1;
    if (!report.status) report.status = 'NEW';
    if (!report.lastSeenAt) report.lastSeenAt = report.createdAt;
    return report;
}

module.exports = function createReportHandlers(redisClient) {

    async function submit(params, id, res) {
        const { type, method, message, context } = params || {};

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing parameter: message' }, id });
        }

        const reportType  = VALID_TYPES.has(type) ? type : 'other';
        const ts          = Date.now();
        const trimmed     = message.trim().slice(0, 1000);
        const fingerprint = fingerprintOf(reportType, method, trimmed);

        // 去重：同指纹已存在 → 计数 +1、活跃时间上浮，不新增条目
        const existingRaw = await redisClient.hGet(FP_KEY, fingerprint);
        if (existingRaw) {
            let existing;
            try { existing = upgrade(JSON.parse(existingRaw)); } catch { existing = null; }
            if (existing) {
                const updated = {
                    ...existing,
                    count:      existing.count + 1,
                    lastSeenAt: new Date(ts).toISOString(),
                    context:    context || existing.context,
                };
                await redisClient.zRem(REPORT_KEY, existingRaw);
                await redisClient.zAdd(REPORT_KEY, { score: ts, value: JSON.stringify(updated) });
                await redisClient.hSet(FP_KEY, fingerprint, JSON.stringify(updated));
                return res.json({ jsonrpc: '2.0', result: { received: true, reportId: updated.id, count: updated.count }, id });
            }
        }

        const report = {
            id:          `${ts}-${Math.random().toString(36).slice(2, 7)}`,
            fingerprint,
            type:        reportType,
            method:      method || null,
            message:     trimmed,
            context:     context || null,
            count:       1,
            status:      'NEW',
            createdAt:   new Date(ts).toISOString(),
            lastSeenAt:  new Date(ts).toISOString(),
        };

        const json = JSON.stringify(report);
        await redisClient.zAdd(REPORT_KEY, { score: ts, value: json });
        await redisClient.hSet(FP_KEY, fingerprint, json);

        // 超出上限时裁剪最旧的（连同去重索引一起清，防 FP hash 泄漏堆积）
        const total = await redisClient.zCard(REPORT_KEY);
        if (total > MAX_REPORTS) {
            const evicted = await redisClient.zRange(REPORT_KEY, 0, total - MAX_REPORTS - 1);
            for (const raw of evicted) {
                try {
                    const r = JSON.parse(raw);
                    if (r.fingerprint) await redisClient.hDel(FP_KEY, r.fingerprint);
                } catch { /* 旧格式无 fingerprint，跳过 */ }
            }
            await redisClient.zRemRangeByRank(REPORT_KEY, 0, total - MAX_REPORTS - 1);
        }

        return res.json({ jsonrpc: '2.0', result: { received: true, reportId: report.id, count: 1 }, id });
    }

    async function list(params, id, res, isAdmin) {
        if (!isAdmin) {
            return res.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Admin only' }, id });
        }

        const { type, status, page = 1, pageSize = 20 } = params || {};

        // 取全部（最多 MAX_REPORTS 条），按 lastSeenAt 倒序（活跃诉求上浮）
        const raw = await redisClient.zRange(REPORT_KEY, 0, -1, { REV: true });
        let items = raw.map(r => { try { return upgrade(JSON.parse(r)); } catch { return null; } }).filter(Boolean);

        if (type && VALID_TYPES.has(type)) {
            items = items.filter(r => r.type === type);
        }
        if (status && VALID_STATUSES.has(status)) {
            items = items.filter(r => r.status === status);
        }

        const total  = items.length;
        const offset = (page - 1) * pageSize;
        return res.json({
            jsonrpc: '2.0',
            result:  { items: items.slice(offset, offset + pageSize), total, page, pageSize },
            id,
        });
    }

    async function update(params, id, res, isAdmin) {
        if (!isAdmin) {
            return res.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Admin only' }, id });
        }

        const { reportId, status } = params || {};
        if (!reportId || !VALID_STATUSES.has(status)) {
            return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'reportId and status (NEW|REVIEWED|RESOLVED) required' }, id });
        }

        // ≤1000 条、管理操作低频，线性查找可接受
        const raw = await redisClient.zRangeWithScores(REPORT_KEY, 0, -1, { REV: true });
        for (const { value, score } of raw) {
            let report;
            try { report = upgrade(JSON.parse(value)); } catch { continue; }
            if (report.id !== reportId) continue;

            const updated = { ...report, status };
            await redisClient.zRem(REPORT_KEY, value);
            await redisClient.zAdd(REPORT_KEY, { score, value: JSON.stringify(updated) });
            if (report.fingerprint) {
                await redisClient.hSet(FP_KEY, report.fingerprint, JSON.stringify(updated));
            }
            return res.json({ jsonrpc: '2.0', result: { updated: true, report: updated }, id });
        }

        return res.json({ jsonrpc: '2.0', error: { code: -32002, message: `Report ${reportId} not found` }, id });
    }

    return { submit, list, update };
};
