const createEntity = require('../../../library/entity');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Approval policy — the rules engine's minimal viable tier (BACKLOG "approval 深挖").
 *
 * @why  Before this, every gate.open / record.request carried its own requiredSigners /
 *       expiry, so the SECURITY posture lived in each caller's code (orchestrator risk
 *       routing, collection's refund gate, …) instead of in one auditable place. A policy
 *       binds a subject PATTERN to defaults:
 *
 *         { subjectPattern: 'workflow:*', requiredSigners: 2, expiresInSec: 86400 }
 *
 *       Explicit caller parameters still win (only-add: existing callers keep exactly
 *       their current behavior); policies only fill the gaps callers leave.
 *
 * Matching: exact pattern first, then the LONGEST trailing-'*' prefix glob. `*` alone is
 * the catch-all. Same glob dialect as the Router's event registry (events.js checkRegistry)
 * — one thing to learn, not two.
 *
 * @attention Policies are ADMIN-writable only (gated in index.js, mirroring token.*):
 *       whoever writes policy decides how many humans a high-risk change needs — that
 *       must not be reachable by the submitter's own lane.
 */
module.exports = (redis, { config }) => {
    const policies = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'policy',
        idLength: (config.idLengths && config.idLengths.policy) || 12,
        softDelete: true,
        searchFields: ['subjectPattern'],
    });

    function assertPattern(subjectPattern) {
        if (!subjectPattern || typeof subjectPattern !== 'string') throw jsonrpc.MISSING_PARAM('subjectPattern');
        // '*' only as a trailing glob (or alone) — mid-pattern wildcards would silently
        // diverge from the event-registry dialect people already know.
        const star = subjectPattern.indexOf('*');
        if (star !== -1 && star !== subjectPattern.length - 1) {
            throw jsonrpc.INVALID_PARAM(`subjectPattern may only use '*' as a trailing glob, got '${subjectPattern}'`);
        }
    }

    async function findByPattern(subjectPattern) {
        const { items } = await policies.list({});
        return items.find((p) => p.subjectPattern === subjectPattern) || null;
    }

    return {
        /** Admin: create or update (upsert by exact subjectPattern — idempotent). */
        async set({ subjectPattern, requiredSigners, expiresInSec, description } = {}) {
            assertPattern(subjectPattern);
            const fields = {};
            if (requiredSigners !== undefined) {
                const m = parseInt(requiredSigners, 10);
                if (!Number.isInteger(m) || m < 1 || m > 20) throw jsonrpc.INVALID_PARAM('requiredSigners must be an integer 1..20');
                fields.requiredSigners = m;
            }
            if (expiresInSec !== undefined) {
                const s = parseInt(expiresInSec, 10);
                if (!Number.isInteger(s) || s < 60) throw jsonrpc.INVALID_PARAM('expiresInSec must be an integer ≥ 60');
                fields.expiresInSec = s;
            }
            if (description !== undefined) fields.description = String(description).slice(0, 300);

            const existing = await findByPattern(subjectPattern);
            if (existing) return policies.update({ id: existing.id, ...fields });
            return policies.create({ subjectPattern, ...fields });
        },

        async delete({ id } = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            return policies.delete({ id });
        },

        async list({ limit, offset } = {}) {
            return policies.list({ limit, offset });
        },

        /**
         * Which policy governs this subject? exact > longest trailing-glob > null.
         * Read path for gate.open/record.request AND exposed as approval.policy.resolve
         * so an operator can answer "what would opening this gate require?" without
         * opening one.
         */
        async resolve({ subject } = {}) {
            if (!subject) throw jsonrpc.MISSING_PARAM('subject');
            const { items } = await policies.list({});

            const exact = items.find((p) => p.subjectPattern === subject);
            if (exact) return { matched: true, policy: exact };

            const globs = items
                .filter((p) => typeof p.subjectPattern === 'string' && p.subjectPattern.endsWith('*'))
                .filter((p) => subject.startsWith(p.subjectPattern.slice(0, -1)))
                .sort((a, b) => b.subjectPattern.length - a.subjectPattern.length);
            if (globs.length) return { matched: true, policy: globs[0] };

            return { matched: false, policy: null };
        },
    };
};
