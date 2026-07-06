const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const createEntity = require('../../../library/entity');
const jsonrpc = require('../handlers/jsonrpc');
const { buildMethodIndex, lintProfile } = require('./lint');
const { generateProfile } = require('./generate');

// Canonical (stable key order) serialization → digest of the EXECUTABLE definition only
// (transitions + meta_fields — what gets reviewed and run). Binds an approval to the exact
// version: change one character and the digest changes (tamper-evident "who approved which").
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
}
function execDigest(profile) {
    return crypto.createHash('sha256').update(canonical({ transitions: profile.transitions || [], meta_fields: profile.meta_fields || [] })).digest('hex');
}

// Governance review axis (separate from the Entity Factory's ACTIVE/DELETED soft-delete
// `status`). A profile is USABLE iff it has no reviewState (trusted direct profile.create)
// OR reviewState === APPROVED. Submitted profiles sit in PENDING_REVIEW until an approver
// (≠ submitter) activates them — mirrors the orchestrator workflow C1 lane.
const REVIEW = { PENDING: 'PENDING_REVIEW', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };

/**
 * Build the lint method index from co-located service introspection. SOLO is single-repo /
 * single-machine (CLAUDE.md §单机部署), so the introspection arrays are local static data —
 * no runtime cross-service RPC, no permit. Best-effort: an unloadable service is skipped; an
 * empty index just makes generation surface method-existence errors instead of silently passing.
 * (In a future multi-process bundle these paths shift — fall back to system.capability.list then.)
 */
function localMethodIndex() {
    const apiRoot = path.join(__dirname, '..', '..', '..');   // api/
    const arrs = [];
    for (const tier of ['core', 'apps']) {
        const dir = path.join(apiRoot, tier);
        let svcs = [];
        try { svcs = fs.readdirSync(dir); } catch { continue; }
        for (const svc of svcs) {
            const f = path.join(dir, svc, 'handlers', 'introspection.js');
            try { if (fs.existsSync(f)) arrs.push(require(f)); } catch { /* skip unloadable */ }
        }
    }
    return buildMethodIndex(arrs);
}

/**
 * Profile Logic
 * @why Fulfillment profiles are state machine configurations stored in Redis.
 *      Uses the shared Entity Factory for consistent CRUD and soft delete behaviour.
 *      `generate` adds the NL → profile path: an LLM (via relay → agent.chat) proposes a
 *      profile, lint.js gates it, errors are fed back for a bounded repair loop, and a
 *      validated CANDIDATE is returned for human review — it does NOT auto-create.
 */
module.exports = (redis, config, relay) => {
    const factory = createEntity(redis, {
        serviceName: config.serviceName,
        entityName:  'profile',
        idLength:    config.idLengths.profile || 8,
        softDelete:  true,
        clientId:    true   // profiles use a meaningful caller-supplied key (e.g. 'standard_trade')
    });

    return {
        create:  (params) => factory.create(params),
        get:     (params) => factory.get(params),
        list:    (params) => factory.list(params),

        // update: trusted direct-create profiles (no reviewState) are unrestricted. For a
        // submission-lane profile, EXECUTABLE fields (transitions / meta_fields) are frozen
        // once submitted — editing them re-opens review: re-lint (reject if broken), reset to
        // PENDING_REVIEW, clear the prior approval. So a usable (APPROVED) profile is ALWAYS
        // exactly what was approved; the edited version must be re-approved (and its instances
        // freeze meanwhile via the instance activation gate). Metadata-only edits pass through.
        update: async (params = {}) => {
            if (!params.id) throw jsonrpc.MISSING_PARAM('id');
            const existing = await factory.get({ id: params.id });
            if (!existing.reviewState) return factory.update(params);
            const execChanged =
                ('transitions' in params && canonical(params.transitions) !== canonical(existing.transitions)) ||
                ('meta_fields' in params && canonical(params.meta_fields) !== canonical(existing.meta_fields));
            if (!execChanged) return factory.update(params);   // metadata-only edit — no re-review
            const lintReport = lintProfile({ ...existing, ...params }, localMethodIndex());
            if (lintReport.errors.length) {
                throw jsonrpc.INVALID_PARAM(`Profile edit failed lint (executable fields are re-checked on edit): ${lintReport.errors.join('; ')}`);
            }
            return factory.update({ ...params, reviewState: REVIEW.PENDING, approvals: [], approvedDigest: null, reReviewOf: existing.approvedDigest || null });
        },

        delete:  (params) => factory.delete(params),
        restore: (params) => factory.restore(params),
        destroy: (params) => factory.destroy(params),

        // NL requirement → lint-clean profile CANDIDATE (review-then-create; never auto-creates).
        generate: async (params = {}) => {
            const { requirement, profileId = null, maxRepairs } = params || {};
            if (!relay) throw jsonrpc.INTERNAL_ERROR('fulfillment.profile.generate requires a relay client (LLM bridge)');
            const callLLM = async (prompt) => {
                const r = await relay.call('agent.chat', { text: prompt });
                return (r && (r.text || r.content)) || '';
            };
            return generateProfile({
                requirement, profileId, callLLM, methodIndex: localMethodIndex(),
                ...(Number.isInteger(maxRepairs) ? { maxRepairs } : {}),
            });
        },

        // ── 投稿面 (submission lane) ───────────────────────────────────────────────
        // submit: untrusted/external authoring → lint-gated PENDING_REVIEW. Only lint-clean
        // profiles enter the review queue (the human reviewer never sees structurally-broken
        // ones); a submitted profile is NOT usable until approved. `allowedActions` (optional)
        // enforces the action policy (rule 6) — the submitter's permitted method set.
        submit: async (params = {}, req) => {
            const { allowedActions = null, ...profile } = params || {};
            if (!profile.name && !profile.id) throw jsonrpc.MISSING_PARAM('name');
            if (!profile.id) {
                profile.id = String(profile.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || `p_${Date.now()}`;
            }
            const lintReport = lintProfile(profile, localMethodIndex(), allowedActions ? { allowedActions } : {});
            if (lintReport.errors.length) {
                return { ok: false, id: profile.id, reviewState: null, lintReport };   // rejected at the gate; nothing stored
            }
            const created = await factory.create({
                ...profile,
                reviewState: REVIEW.PENDING,
                submittedBy: req?.user || null,
                approvals: [],
                submittedAt: Date.now(),
            });
            return { ok: true, id: created.id, reviewState: REVIEW.PENDING, lintReport };
        },

        // approve: PENDING_REVIEW → APPROVED. Approver must differ from the submitter
        // (separation of duties); admin-gated at the handler. Now the profile is usable.
        approve: async ({ id } = {}, req) => {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const profile = await factory.get({ id });
            if (profile.reviewState !== REVIEW.PENDING) throw jsonrpc.FORBIDDEN(`Cannot approve a profile in reviewState: ${profile.reviewState || '(none)'}`);
            const caller = req?.user || null;
            if (caller && profile.submittedBy && caller === profile.submittedBy) throw jsonrpc.FORBIDDEN('Approver cannot be the same as the submitter');
            // Bind the approval to the exact executable definition (tamper-evident). A later
            // executable edit resets reviewState (see update) → this digest no longer applies.
            const digest = execDigest(profile);
            return factory.update({
                id,
                reviewState: REVIEW.APPROVED,
                approvedDigest: digest,
                approvals: [...(profile.approvals || []), { approvedBy: caller, approvedAt: Date.now(), digest }],
            });
        },

        // reject: PENDING_REVIEW → REJECTED (stays unusable; restore re-submits via update).
        reject: async ({ id, reason = null } = {}, req) => {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const profile = await factory.get({ id });
            if (profile.reviewState !== REVIEW.PENDING) throw jsonrpc.FORBIDDEN(`Cannot reject a profile in reviewState: ${profile.reviewState || '(none)'}`);
            return factory.update({ id, reviewState: REVIEW.REJECTED, rejectReason: reason, rejectedBy: req?.user || null, rejectedAt: Date.now() });
        },
    };
};
