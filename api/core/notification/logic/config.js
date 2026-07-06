const jsonrpc = require('../handlers/jsonrpc');

module.exports = (redis, config) => {
    const R = config.redis;

    function validateRules(rules) {
        if (!Array.isArray(rules)) throw jsonrpc.INVALID_PARAMS('rules must be an array');
        const allowed = new Set(['email', 'sms', 'webhook', 'none']);
        for (const r of rules) {
            if (!r.type)                 throw jsonrpc.INVALID_PARAMS('rule.type required');
            // sse fail-closed: no gateway.sse.send exists — rejecting at config time is
            // honest; accepting used to mean every matching message silently dead-lettered.
            if (r.channel === 'sse') {
                throw jsonrpc.INVALID_PARAMS("channel 'sse' is not implemented — use inbox (default) or webhook");
            }
            if (!allowed.has(r.channel)) throw jsonrpc.INVALID_PARAMS(`rule.channel invalid: ${r.channel}`);
            // webhook targets are machines, not users — no profile to fall back to,
            // so the URL must be configured up front.
            if (r.channel === 'webhook' && !(r.params && typeof r.params.url === 'string' && /^https?:\/\//.test(r.params.url))) {
                throw jsonrpc.INVALID_PARAMS('webhook rule requires params.url (http/https)');
            }
        }
    }

    async function set({ targetId, rules } = {}) {
        if (!targetId) throw jsonrpc.MISSING_PARAM('targetId');
        validateRules(rules);
        const payload = { targetId, rules, updatedAt: Date.now() };
        await redis.set(R.configPrefix + targetId, JSON.stringify(payload));
        return { targetId };
    }

    async function get({ targetId } = {}) {
        if (!targetId) throw jsonrpc.MISSING_PARAM('targetId');
        const raw = await redis.get(R.configPrefix + targetId);
        if (!raw) return { targetId, rules: [] };
        const cfg = JSON.parse(raw);
        return { targetId, rules: cfg.rules || [] };
    }

    return { set, get };
};
