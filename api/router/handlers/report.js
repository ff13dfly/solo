/**
 * system.report / system.report.list
 *
 * 外部 AI 主动反馈接口。用于收集：
 *   - 缺少的能力（missing_capability）
 *   - returns 字段不足（bad_returns）
 *   - 描述不清晰（unclear_description）
 *   - 调用链中断（chain_failure）
 *   - 其他（other）
 *
 * system.report      — public，无需 token，AI 随时提交
 * system.report.list — 管理员查看收集到的报告
 */

const REPORT_KEY   = 'SYSTEM:AI:REPORT';   // Sorted Set，score = timestamp
const MAX_REPORTS  = 1000;                  // 最多保留最新 1000 条

const VALID_TYPES = new Set([
    'missing_capability',
    'bad_returns',
    'unclear_description',
    'chain_failure',
    'other',
]);

module.exports = function createReportHandlers(redisClient) {

    async function submit(params, id, res) {
        const { type, method, message, context } = params || {};

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing parameter: message' }, id });
        }

        const reportType = VALID_TYPES.has(type) ? type : 'other';
        const ts = Date.now();

        const report = {
            id:        `${ts}-${Math.random().toString(36).slice(2, 7)}`,
            type:      reportType,
            method:    method || null,
            message:   message.trim().slice(0, 1000),
            context:   context || null,
            createdAt: new Date(ts).toISOString(),
        };

        await redisClient.zAdd(REPORT_KEY, { score: ts, value: JSON.stringify(report) });

        // 超出上限时裁剪最旧的
        const total = await redisClient.zCard(REPORT_KEY);
        if (total > MAX_REPORTS) {
            await redisClient.zRemRangeByRank(REPORT_KEY, 0, total - MAX_REPORTS - 1);
        }

        return res.json({ jsonrpc: '2.0', result: { received: true, reportId: report.id }, id });
    }

    async function list(params, id, res, isAdmin) {
        if (!isAdmin) {
            return res.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Admin only' }, id });
        }

        const { type, page = 1, pageSize = 20 } = params || {};

        // 取全部（最多 MAX_REPORTS 条），倒序
        const raw = await redisClient.zRange(REPORT_KEY, 0, -1, { REV: true });
        let items = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

        if (type && VALID_TYPES.has(type)) {
            items = items.filter(r => r.type === type);
        }

        const total  = items.length;
        const offset = (page - 1) * pageSize;
        return res.json({
            jsonrpc: '2.0',
            result:  { items: items.slice(offset, offset + pageSize), total, page, pageSize },
            id,
        });
    }

    return { submit, list };
};
