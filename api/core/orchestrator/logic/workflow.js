/**
 * Workflow Business Logic
 * @why Manages the lifecycle of machine-executable workflows. Unlike simple RPC 
 *      methods, workflows are "composed" logic that live in Redis.
 * @attention 
 *   1. SOFT DELETE: Workflows are never truly deleted from Redis; they are 
 *      marked as `DELETED` to preserve execution history/traces.
 *   2. ATOMICTY: Uses RedisJSON for atomic updates to the workflow structure.
 *   3. AI OPTIMIZATION: `build()` creates a localized snapshot that the Agent 
 *      consumes for high-performance intent matching.
 */
const crypto = require('crypto');
const { generateId } = require('../../../library/generator');
const { optimisticJsonUpdate } = require('../../../library/optimistic');
const { classifyFootprint } = require('../../../library/risk');
const jsonrpc = require('../handlers/jsonrpc');
const config = require('../config');
const Distinct = require('./distinct');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('orchestrator-workflow');

// toFix §6.6 — immutable version snapshot key for one (workflow, version).
function versionKey(id, version) {
    return `${config.redis.workflowVersionPrefix}${id}:${version}`;
}

// VERSION.md §3.1 — full method names a workflow invokes (steps + resolvers), the
// input to risk classification. Mirrors runner's fullMethod ({service}.{method}).
function footprintOf(workflow) {
    const fromStep = (s) => (s && typeof s.method === 'string')
        ? (s.method.startsWith(`${s.service}.`) ? s.method : `${s.service}.${s.method}`)
        : null;
    return [
        ...((workflow.steps || []).map(fromStep)),
        ...Object.values(workflow.resolvers || {}).map((r) => r && r.method),
    ].filter((m) => typeof m === 'string' && m.length > 0);
}

// §7.4 — resolve a step to its full {service}.{method} name (mirrors footprintOf.fromStep).
function fullMethodOf(step) {
    if (!step || typeof step.method !== 'string') return null;
    return step.method.startsWith(`${step.service}.`) ? step.method : `${step.service}.${step.method}`;
}

// §7.4 — split the workflow's methods into those MISSING from the live capability catalog,
// separating COMPENSATION-step methods (the Saga rollback safety net — fail-closed, because a
// missing one fails UNSAFE: forward steps already committed when it can't run) from forward /
// resolver methods (fail-fast at run with no committed side effects — warn only). Pure; the
// catalog is a Set of full method names.
function classifyMissingMethods(workflow, catalog) {
    const compTargets = new Set((workflow.steps || []).map((s) => s && s.compensate).filter(Boolean));
    const missingComp = [];
    const missingFwd = [];
    for (const step of workflow.steps || []) {
        const m = fullMethodOf(step);
        if (!m || catalog.has(m)) continue;
        (compTargets.has(step.id) ? missingComp : missingFwd).push(`${step.id} → ${m}`);
    }
    for (const [rkey, r] of Object.entries(workflow.resolvers || {})) {
        const m = r && typeof r.method === 'string' ? r.method : null;
        if (m && !catalog.has(m)) missingFwd.push(`resolver:${rkey} → ${m}`);
    }
    return { missingComp, missingFwd };
}

// §7.4 — the Router-published method catalog (`system:capability:list`) as a Set of method
// names, or null when unavailable/empty so callers SKIP the check (a transient catalog miss
// must not block every approval). Plain string value — the Router writes JSON.stringify(map).
async function loadCapabilityCatalog(redis) {
    try {
        const raw = await redis.get('system:capability:list');
        if (!raw) return null;
        const names = Object.keys(JSON.parse(raw) || {});
        return names.length ? new Set(names) : null;
    } catch (_) {
        return null;
    }
}

// Deterministic JSON (sorted keys) so the approval digest is stable across callers.
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',')}}`;
}

// §3.1/§3.2 — the digest approvers sign: binds the workflow id to EXACTLY the parts
// of the definition the approval UI shows (steps + subscriptions + input_schema). Any
// edit changes the digest → prior signatures no longer apply. Deliberately excludes
// `version` so the activation-time version bump doesn't invalidate a fresh signature
// (the gate subject `workflow:{id}:v{n}` records which version was approved).
function approvalDigest(workflow) {
    const material = stableStringify({
        id: workflow.id,
        steps: workflow.steps || [],
        event_subscriptions: workflow.event_subscriptions || [],
        input_schema: workflow.input_schema || [],
    });
    return crypto.createHash('sha256').update(material).digest('hex');
}

// Attach risk classification + the approval config that follows from it. Submitter
// CANNOT weaken this — risk is derived from the footprint (confused-deputy guard),
// and the multi-sig parameters come from service config, not the submission.
function withRiskClassification(workflow) {
    const { level, reasons } = classifyFootprint(footprintOf(workflow), {
        sensitiveServices: config.approval && config.approval.sensitiveServices,
    });
    workflow.risk_level = level;
    workflow.risk_reasons = reasons.slice(0, 12);
    const A = config.approval || {};
    workflow.approval_config = level === 'HIGH'
        ? { requiredSigners: A.requiredSignersHigh || 1, coolingMs: A.coolingMsHigh || 0, expirySec: A.gateExpirySec || 259200 }
        : { requiredSigners: 1, coolingMs: 0, expirySec: A.gateExpirySec || 259200 };
    return workflow;
}

// event.md §7 — the trigger sources a workflow may declare in allowed_triggers.
const VALID_TRIGGERS = ['sync', 'event', 'cron', 'webhook'];

// Normalize + validate an allowed_triggers value. Returns a clean array.
// Default ['sync'] preserves existing sync-only behavior when unset/empty.
function normalizeAllowedTriggers(value) {
    if (value === undefined || value === null) return ['sync'];
    if (!Array.isArray(value)) throw jsonrpc.INVALID_PARAMS('allowed_triggers must be an array');
    const bad = value.filter(t => !VALID_TRIGGERS.includes(t));
    if (bad.length > 0) throw jsonrpc.INVALID_PARAMS(`Invalid allowed_triggers: ${bad.join(', ')} (valid: ${VALID_TRIGGERS.join(', ')})`);
    return value.length > 0 ? [...new Set(value)] : ['sync'];
}

// event.md §6.1 — event_subscriptions: which streams+filters trigger this workflow.
// Each entry: { stream: 'EVENT:ORDER:CREATED', filter?: { type: 'order.paid' } }
function normalizeEventSubscriptions(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw jsonrpc.INVALID_PARAMS('event_subscriptions must be an array');
    for (const sub of value) {
        if (typeof sub !== 'object' || !sub) throw jsonrpc.INVALID_PARAMS('each event_subscription must be an object');
        if (typeof sub.stream !== 'string' || !sub.stream) throw jsonrpc.INVALID_PARAMS('each event_subscription must have a stream string');
        if (sub.filter !== undefined && (typeof sub.filter !== 'object' || Array.isArray(sub.filter) || sub.filter === null)) {
            throw jsonrpc.INVALID_PARAMS('event_subscription filter must be a plain object');
        }
    }
    return value;
}

module.exports = (redis, { serviceName, relay } = {}) => {
    // §3.4 — external submission quota: per-submitter hourly rate + a global cap on
    // the PENDING_REVIEW backlog (a flooded queue is a DoS on approver attention).
    async function enforceSubmissionQuota(uid) {
        const sub = config.submission || {};
        const max = sub.maxPerHourPerUser || 10;
        const cap = sub.pendingCap || 100;

        const rateKey = `ORCH:PROPOSALS:${uid}`;
        const n = await redis.incr(rateKey);
        if (n === 1) await redis.expire(rateKey, sub.windowSec || 3600);
        if (n > max) throw jsonrpc.FORBIDDEN(`Submission quota exceeded (${max}/${(sub.windowSec || 3600)}s) — try later`);

        // Global PENDING_REVIEW backlog cap (bounded scan of the id index).
        let pending = 0;
        const ids = await redis.sMembers(config.redis.workflowIndex).catch(() => []);
        for (const wid of ids) {
            const wf = await redis.json.get(`${config.redis.workflowPrefix}${wid}`).catch(() => null);
            if (wf && wf.status === 'PENDING_REVIEW' && ++pending >= cap) {
                throw jsonrpc.FORBIDDEN(`Approval backlog full (${cap} pending) — submissions paused`);
            }
        }
    }

    // --- WORKFLOW MANAGEMENT ---
    const methods = {
        /**
         * Create a new workflow
         * 
         * @why Allows dynamic expansion of system capabilities without code deployment.
         * @attention 
         *   1. ID GENERATION: If no ID provided, generates a short string based 
         *      on `config.idLengths.workflow`.
         *   2. STEP VALIDATION: Strictly validates the existence of `id`, `service`, 
         *      and `method` for every step to prevent runtime crashes.
         * @side_effects Persists the workflow object to Redis under the `workflowPrefix`.
         */
        async create({
            id, category, priority, name, desc,
            tags, examples, negative, keywords,
            required_inputs, optional_inputs, synonyms,
            steps, resolvers, allowed_triggers,
            event_subscriptions, input_schema, strict_result,
            require_actor_permit
        }, callerUid = null, ctx = {}) {
            // Validation
            if (!category) throw jsonrpc.MISSING_PARAM('category');
            if (!name) throw jsonrpc.MISSING_PARAM('name');
            if (!desc) throw jsonrpc.MISSING_PARAM('desc');
            if (!steps || !Array.isArray(steps)) throw jsonrpc.MISSING_PARAM('steps');

            // §3.4 — submission quota for EXTERNAL (non-admin) submitters only. An
            // unbounded workflow.create is a DoS surface (floods the PENDING_REVIEW
            // queue / approver attention). Operators (admin) are unthrottled.
            if (ctx.isAdmin === false && callerUid) {
                await enforceSubmissionQuota(callerUid);
            }

            // Auto-generate ID if missing (after quota — a rejected submission consumes no id)
            if (!id) {
                id = generateId(config.idLengths.workflow || 6);
            }


            // Validate steps structure
            const stepIds = new Set(steps.map((s) => s && s.id).filter(Boolean));
            for (const step of steps) {
                if (!step.id) throw jsonrpc.INVALID_PARAMS('step.id required');
                if (!step.service) throw jsonrpc.INVALID_PARAMS('step.service required');
                if (!step.method) throw jsonrpc.INVALID_PARAMS('step.method required');
                if (!step.params || typeof step.params !== 'object') {
                    throw jsonrpc.INVALID_PARAMS('step.params object required');
                }
                // Saga compensation (README §7): `compensate` is a step-id reference. Validate at
                // submission so the approval review sees coherent rollback wiring: it must point
                // at a real OTHER step, and a compensation step must not itself declare
                // `compensate` (§7.3 — no compensation chains). The target is a normal step, so
                // it is already in the footprint (H6 pre-check) and the signed approval digest.
                if (step.compensate !== undefined && step.compensate !== null) {
                    if (typeof step.compensate !== 'string') {
                        throw jsonrpc.INVALID_PARAMS(`step '${step.id}'.compensate must be a step id (string)`);
                    }
                    if (step.compensate === step.id) {
                        throw jsonrpc.INVALID_PARAMS(`step '${step.id}' cannot compensate itself`);
                    }
                    if (!stepIds.has(step.compensate)) {
                        throw jsonrpc.INVALID_PARAMS(`step '${step.id}'.compensate references unknown step '${step.compensate}'`);
                    }
                    const target = steps.find((s) => s.id === step.compensate);
                    if (target && target.compensate !== undefined && target.compensate !== null) {
                        throw jsonrpc.INVALID_PARAMS(`compensation step '${step.compensate}' cannot itself declare compensate (§7.3)`);
                    }
                }
            }


            const now = Date.now();
            const workflow = {
                id,
                category,
                priority: priority || 50,
                name,
                desc,
                tags: tags || [],
                examples: examples || [],
                negative: negative || [],
                keywords: keywords || [],
                required_inputs: required_inputs || [],
                optional_inputs: optional_inputs || [],
                synonyms: synonyms || {},
                steps,
                resolvers: resolvers || {},
                // event.md §7 — which trigger sources may run this workflow.
                allowed_triggers: normalizeAllowedTriggers(allowed_triggers),
                // event.md §6.1 — which streams/filters trigger this workflow (matcher reads
                // these). Accepted at submission so AI-authored event-triggered workflows work
                // and the approval review shows "what can trigger it" (§3.3). Was injection-only.
                event_subscriptions: normalizeEventSubscriptions(event_subscriptions),
                // toFix §6.3 — input contract (runner fail-closes on violation). Accepted at
                // submission so the approval review shows the declared schema.
                input_schema: Array.isArray(input_schema) ? input_schema : [],
                strict_result: strict_result === true,
                // AUDIT C4 minimal tier — opt-in actor pre-check: event-triggered runs
                // additionally require the TRIGGERING actor's own permit to cover the
                // footprint (runner §2.6, fail-closed on non-resolvable provenance).
                // Default false = today's bot-permit-only (H6) behavior.
                require_actor_permit: require_actor_permit === true,
                // Resolver method safety: no blacklist here — C1 approval (different user
                // must approve) and H6 footprint pre-check are the real security gates.
                // C1: all newly created workflows begin in PENDING_REVIEW.
                // An approver (≠ submitter) must call workflow.approve before execution.
                status: 'PENDING_REVIEW',
                submittedBy: callerUid || null,
                approvals: [],
                createdAt: now,
                updatedAt: now
            };

            // §3.1 — derive risk + approval config from the footprint (NOT the submitter's
            // claim). HIGH-risk workflows route to the multi-sig lane in approve().
            withRiskClassification(workflow);

            const existingKey = `${config.redis.workflowPrefix}${id}`;

            // toFix §6.6 — every definition revision gets a monotonic version number
            // and an immutable snapshot, so a run can always answer "which definition
            // was live when I executed". Fresh ids start at 1.
            workflow.version = 1;

            // Atomic create: NX prevents TOCTOU when same ID is submitted concurrently.
            const claimed = await redis.json.set(existingKey, '$', workflow, { NX: true });
            if (!claimed) {
                // Key exists — allow overwrite only if the existing workflow is DELETED
                const existing = await redis.json.get(existingKey);
                if (!existing || existing.status !== 'DELETED') {
                    throw jsonrpc.INVALID_PARAMS('Workflow already exists');
                }

                // Re-created over a DELETED doc: continue its version line so the old
                // versions' snapshots are never overwritten (audit history survives).
                workflow.version = (existing.version || 0) + 1;
                await redis.json.set(existingKey, '$', workflow);
            }

            // Maintain the id index (SET) so list()/matcher use SMEMBERS, not KEYS.
            await redis.sAdd(config.redis.workflowIndex, id);

            // Immutable v{n} snapshot (best-effort at create; update/approve write theirs
            // inside the CAS transaction). A snapshot miss is logged, never fatal.
            await redis.json.set(versionKey(id, workflow.version), '$', workflow)
                .catch(e => logger.warn(`version snapshot failed (${id} v${workflow.version}):`, e.message));

            return workflow;
        },

        /**
         * Backfill the workflow id index from existing docs (one-time, boot-only).
         * @why The index replaces KEYS scans; legacy / directly-injected workflow docs
         *      (created before the index existed, or via dev injection) must be added so
         *      the matcher (now SMEMBERS-based) still finds them. KEYS here is acceptable:
         *      it runs ONCE at startup, never on the hot path.
         */
        async rebuildIndex() {
            const keys = await redis.keys(`${config.redis.workflowPrefix}*`);
            if (!keys.length) return 0;
            const ids = keys.map(k => k.slice(config.redis.workflowPrefix.length)).filter(Boolean);
            if (ids.length) await redis.sAdd(config.redis.workflowIndex, ids);
            return ids.length;
        },

        /**
         * Get a single workflow by ID
         */
        async get({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            
            const workflow = await redis.json.get(`${config.redis.workflowPrefix}${id}`);
            if (!workflow) throw jsonrpc.NOT_FOUND('Workflow');

            
            return workflow;
        },

        /**
         * List workflows with optional filters
         * 
         * @why Used by the Admin Portal to manage the workflow registry.
         * @attention 
         *   1. PERFORMANCE: Uses `keys *` which is O(N). Acceptable for 
         *      admin-only metadata but avoid high-frequency caller usage.
         *   2. SORTING: Prioritizes higher `priority` values and then sorts by `name`.
         */
        async list({ category, includeDeleted = false, limit = 50, offset = 0 } = {}) {
            const ids = await redis.sMembers(config.redis.workflowIndex);
            const keys = ids.map(id => `${config.redis.workflowPrefix}${id}`);

            const workflows = [];

            for (const key of keys) {
                const workflow = await redis.json.get(key);
                if (!workflow) continue;
                
                // Filter by status: show ACTIVE + PENDING_REVIEW + DEPRECATED by default
                // (DEPRECATED is a visible "retired" registry entry, not a hidden one);
                // DELETED only with includeDeleted=true; REJECTED always visible for management.
                if (workflow.status === 'DELETED' && !includeDeleted) continue;
                
                // Filter by category
                if (category) {
                    const reqCat = typeof category === 'string' ? category : JSON.stringify(category);
                    const storedCat = typeof workflow.category === 'string' ? workflow.category : JSON.stringify(workflow.category);
                    if (reqCat !== storedCat) continue;
                }
                
                workflows.push(workflow);
            }

            // Sort by priority (descending), then by name
            workflows.sort((a, b) => {
                if (b.priority !== a.priority) return b.priority - a.priority;
                return a.name.localeCompare(b.name);
            });

            // Pagination
            const total = workflows.length;
            const paginated = workflows.slice(offset, offset + limit);

            return {
                items: paginated,
                total,
                limit,
                offset
            };
        },

        /**
         * Update workflow metadata or steps
         * 
         * @why Refines existing workflows as business requirements change.
         * @attention 
         *   1. RESOLVER LOCKDOWN: Strictly forbids write-only methods (create, delete, etc.) 
         *      in resolvers to prevent unintended side effects during ID resolution.
         *   2. SNAPSHOT SYNC: After updating, you MUST call `build()` to sync with the Agent.
         */
        async update({ id, name, desc, category, priority, tags, examples, negative, keywords,
                    required_inputs, optional_inputs, synonyms, allowed_triggers, steps, resolvers,
                    event_subscriptions, input_schema, strict_result, require_actor_permit, expected_version }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');

            // Validate steps shape once, outside the CAS retry loop (pure input check).
            if (steps !== undefined) {
                if (!Array.isArray(steps)) throw jsonrpc.INVALID_PARAMS('steps must be array');
                for (const step of steps) {
                    if (!step.id) throw jsonrpc.INVALID_PARAMS('step.id required');
                    if (!step.service) throw jsonrpc.INVALID_PARAMS('step.service required');
                    if (!step.method) throw jsonrpc.INVALID_PARAMS('step.method required');
                }
            }
            // Validate event_subscriptions shape once (pure input check).
            const normSubs = event_subscriptions !== undefined ? normalizeEventSubscriptions(event_subscriptions) : undefined;

            const key = `${config.redis.workflowPrefix}${id}`;

            // toFix §6.6 — WATCH/MULTI CAS: two admins editing concurrently no longer
            // clobber each other (the loser's mutate re-runs against the fresh doc).
            // expected_version (optional) additionally protects human intent: an edit
            // composed against a stale copy is rejected instead of silently merged.
            // The version bump + immutable v{n} snapshot commit in the SAME transaction.
            const updated = await optimisticJsonUpdate(redis, key, (existing) => {
                // DEPRECATED is frozen like DELETED — editing it in place would let a
                // retired workflow's audited definition drift without going back through
                // restore() + full re-approval (P1, 2026-07-05).
                if (existing.status === 'DELETED') throw jsonrpc.FORBIDDEN('Workflow deleted');
                if (existing.status === 'DEPRECATED') throw jsonrpc.FORBIDDEN('Workflow deprecated');

                if (expected_version !== undefined && (existing.version || 0) !== expected_version) {
                    throw jsonrpc.FORBIDDEN(`Version conflict: expected ${expected_version}, current ${existing.version || 0} — reload and re-apply`);
                }

                // Freeze executable fields on ACTIVE workflows — approval gate must not be bypassed.
                // require_actor_permit is in this set: flipping the actor gate OFF on a live
                // workflow would silently widen who can trigger it, past what was approved.
                const isActive = existing.status === 'ACTIVE';
                if (isActive && (steps !== undefined || resolvers !== undefined || require_actor_permit !== undefined)) {
                    throw jsonrpc.FORBIDDEN('Workflow locked');
                }

                const next = { ...existing };
                if (name !== undefined) next.name = name;
                if (desc !== undefined) next.desc = desc;
                if (category !== undefined) next.category = category;
                if (priority !== undefined) next.priority = priority;
                if (tags !== undefined) next.tags = tags;
                if (examples !== undefined) next.examples = examples;
                if (negative !== undefined) next.negative = negative;
                if (keywords !== undefined) next.keywords = keywords;
                if (required_inputs !== undefined) next.required_inputs = required_inputs;
                if (optional_inputs !== undefined) next.optional_inputs = optional_inputs;
                if (synonyms !== undefined) next.synonyms = synonyms;
                if (allowed_triggers !== undefined) next.allowed_triggers = normalizeAllowedTriggers(allowed_triggers);
                if (resolvers !== undefined) {
                    // No method-name blacklist — C1 approval gate and H6 footprint pre-check
                    // are the security boundaries. A keyword regex gives false confidence
                    // (trivially bypassed by naming) and blocks legitimate read methods.
                    next.resolvers = resolvers;
                }
                if (steps !== undefined) next.steps = steps;
                if (normSubs !== undefined) next.event_subscriptions = normSubs;
                if (input_schema !== undefined) next.input_schema = Array.isArray(input_schema) ? input_schema : [];
                if (strict_result !== undefined) next.strict_result = strict_result === true;
                if (require_actor_permit !== undefined) next.require_actor_permit = require_actor_permit === true;

                // §3.1 — a definition edit re-derives risk and INVALIDATES any in-flight
                // approval gate: the signed digest (steps + subscriptions + input_schema)
                // no longer matches. Covers every field the digest binds, plus
                // require_actor_permit (not digest-bound, but it changes WHO may trigger
                // the approved definition — a mid-review flip must void collected signatures).
                if (steps !== undefined || resolvers !== undefined || normSubs !== undefined || input_schema !== undefined || require_actor_permit !== undefined) {
                    withRiskClassification(next);
                    delete next.gateId;
                    delete next.effective_at;
                }

                next.version = (existing.version || 0) + 1;
                next.updatedAt = Date.now();
                return next;
            }, {
                onMulti: (multi, { next }) => multi.json.set(versionKey(id, next.version), '$', next),
            });

            if (!updated) throw jsonrpc.NOT_FOUND('Workflow');
            return updated;
        },

        /**
         * Soft delete a workflow
         */
        async delete({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');

            const key = `${config.redis.workflowPrefix}${id}`;
            const existing = await redis.json.get(key);
            if (!existing) throw jsonrpc.NOT_FOUND('Workflow');

            if (existing.status === 'DELETED') {
                return { success: true, message: 'Already deleted' };
            }

            await optimisticJsonUpdate(redis, key, (doc) => ({
                ...doc,
                status: 'DELETED',
                updatedAt: Date.now(),
                deletedAt: Date.now(),
            }));
            return { success: true };
        },

        /**
         * Retire a live workflow: ACTIVE → DEPRECATED.
         *
         * @why `delete()` is a blunt instrument — it takes ANY status (including ACTIVE)
         *      straight to the same DELETED terminal state as discarding a draft that was
         *      never approved, so the audit trail can't tell "retired a production workflow"
         *      apart from "threw away a rejected proposal". `deprecate()` gives the former
         *      its own status + timestamp; `delete()` is unaffected and still works from any
         *      status (kept as the blunt/emergency path, e.g. killing a compromised workflow).
         * @attention Reactivating a DEPRECATED workflow goes through `restore()`, which (like
         *      DELETED/REJECTED today) always lands back in PENDING_REVIEW — full re-approval,
         *      never a direct return to ACTIVE (v1-implementation-plan.md P1, decided 2026-07-05:
         *      no lightweight/time-windowed reactivation shortcut).
         */
        async deprecate({ id } = {}, callerUid = null) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');

            const key = `${config.redis.workflowPrefix}${id}`;
            const updated = await optimisticJsonUpdate(redis, key, (existing) => {
                if (existing.status !== 'ACTIVE') {
                    throw jsonrpc.FORBIDDEN(`Cannot deprecate a workflow in status: ${existing.status}`);
                }
                return {
                    ...existing,
                    status: 'DEPRECATED',
                    updatedAt: Date.now(),
                    deprecatedAt: Date.now(),
                    deprecatedBy: callerUid || null,
                };
            });

            if (!updated) throw jsonrpc.NOT_FOUND('Workflow');
            return { success: true, workflow: updated };
        },

        /**
         * Approve a PENDING_REVIEW workflow → ACTIVE (C1)
         *
         * Rules enforced here:
         *   - Workflow must be in PENDING_REVIEW
         *   - Approver must not be the original submitter (self-approval ban)
         *   - Each uid may only approve once (deduplicated)
         *
         * Dual-signature (AUDIT A5) is deferred until `requires_dual_approval`
         * declarations land on service entities. For now: one approval → ACTIVE.
         */
        /**
         * Approve a PENDING_REVIEW workflow → ACTIVE (VERSION.md §3.1 — layered).
         *
         *   LOW risk  → C1 fast lane: one approver (≠ submitter) flips ACTIVE.
         *   HIGH risk → multi-sig lane: m-of-n approvers must each Ed25519-sign the
         *               definition digest via the approval service; on the threshold
         *               the workflow activates with a cooling period before it can run.
         *
         * HIGH-risk contract (portal): call once with no `signature` → returns
         * { status:'NEEDS_SIGNATURE', digest, gateId }; sign the digest (user.key.sign);
         * call again with `signature`. Repeat per approver until APPROVED.
         */
        async approve({ id, signature } = {}, callerUid = null) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const key = `${config.redis.workflowPrefix}${id}`;

            const wf = await redis.json.get(key);
            if (!wf) throw jsonrpc.NOT_FOUND('Workflow');
            if (wf.status !== 'PENDING_REVIEW') throw jsonrpc.FORBIDDEN(`Cannot approve a workflow in status: ${wf.status}`);
            if (callerUid && wf.submittedBy && callerUid === wf.submittedBy) {
                throw jsonrpc.FORBIDDEN('Approver cannot be the same as the submitter');
            }

            // ── §7.4: compensation-interface existence pre-check (before either lane) ──
            // A compensate step whose downstream method exists in no active service is a
            // rollback that cannot run — and it fails UNSAFE (forward steps commit, then the
            // safety net is discovered broken). Reject. Forward/resolver methods only WARN
            // (a missing one fails fast at run with nothing committed before it). Skipped when
            // the catalog is unavailable, so a transient miss never blocks every approval.
            const catalog = await loadCapabilityCatalog(redis);
            if (catalog) {
                const { missingComp, missingFwd } = classifyMissingMethods(wf, catalog);
                if (missingComp.length) {
                    throw jsonrpc.INVALID_PARAMS(`Compensation method(s) provided by no active service — the Saga rollback cannot run: ${missingComp.join('; ')}`);
                }
                if (missingFwd.length) {
                    logger.warn(`approve(${id}): method(s) not in capability catalog (will fail at run): ${missingFwd.join('; ')}`);
                }
            }

            // ── LOW: C1 fast single-sign lane ───────────────────────────────────
            if ((wf.risk_level || 'LOW') !== 'HIGH') {
                const updated = await optimisticJsonUpdate(redis, key, (existing) => {
                    if (existing.status !== 'PENDING_REVIEW') throw jsonrpc.FORBIDDEN(`Cannot approve a workflow in status: ${existing.status}`);
                    if (callerUid && existing.submittedBy && callerUid === existing.submittedBy) throw jsonrpc.FORBIDDEN('Approver cannot be the same as the submitter');
                    const approvals = existing.approvals || [];
                    if (callerUid && approvals.some(a => a.approvedBy === callerUid)) throw jsonrpc.FORBIDDEN('Already approved by this user');
                    return {
                        ...existing,
                        approvals: [...approvals, { approvedBy: callerUid || null, approvedAt: Date.now() }],
                        status: 'ACTIVE',
                        version: (existing.version || 0) + 1,
                        updatedAt: Date.now(),
                    };
                }, { onMulti: (multi, { next }) => multi.json.set(versionKey(id, next.version), '$', next) });
                if (!updated) throw jsonrpc.NOT_FOUND('Workflow');
                return { success: true, lane: 'C1', workflow: updated };
            }

            // ── HIGH: multi-signature lane via the approval service ──────────────
            if (!relay) throw jsonrpc.INTERNAL_ERROR('High-risk approval requires the approval service (relay not configured)');

            const digest = approvalDigest(wf);
            const cfg = wf.approval_config || {};

            // Ensure a gate exists (idempotent: gateId is stored on the workflow).
            let gateId = wf.gateId;
            if (!gateId) {
                const gate = await relay.call('approval.gate.open', {
                    subject: `workflow:${id}:v${wf.version}`,
                    digest,
                    requiredSigners: cfg.requiredSigners || 1,
                    expiresInSec: cfg.expirySec || 259200,
                    submitterUid: wf.submittedBy || null,
                });
                gateId = gate.id;
                await optimisticJsonUpdate(redis, key, (e) => ({ ...e, gateId }));
            }

            // Tell the caller what to sign.
            if (!signature) {
                return { success: false, status: 'NEEDS_SIGNATURE', lane: 'multisig', gateId, digest, required: cfg.requiredSigners || 1 };
            }

            // Submit this approver's signature; the gate verifies it against their key.
            const res = await relay.call('approval.gate.sign', { id: gateId, approverUid: callerUid, signature });
            if (res.state !== 'APPROVED') {
                return { success: false, status: 'AWAITING_SIGNATURES', lane: 'multisig', gateId, signed: res.signed, required: res.required };
            }

            // Threshold reached → activate, with a cooling period before it can run.
            const coolingMs = cfg.coolingMs || 0;
            const updated = await optimisticJsonUpdate(redis, key, (existing) => {
                if (existing.status !== 'PENDING_REVIEW') throw jsonrpc.FORBIDDEN(`Cannot approve a workflow in status: ${existing.status}`);
                return {
                    ...existing,
                    status: 'ACTIVE',
                    approvals: [...(existing.approvals || []), { approvedBy: callerUid || null, approvedAt: Date.now(), gateId, signature }],
                    effective_at: coolingMs > 0 ? Date.now() + coolingMs : null,
                    version: (existing.version || 0) + 1,
                    updatedAt: Date.now(),
                };
            }, { onMulti: (multi, { next }) => multi.json.set(versionKey(id, next.version), '$', next) });
            if (!updated) throw jsonrpc.NOT_FOUND('Workflow');
            return { success: true, lane: 'multisig', gateId, effective_at: updated.effective_at, workflow: updated };
        },

        /**
         * Deny a PENDING_REVIEW workflow → REJECTED (C1)
         * The workflow stays in REJECTED until restored (which returns it to PENDING_REVIEW).
         */
        async deny({ id, reason }, callerUid = null) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');

            const key = `${config.redis.workflowPrefix}${id}`;
            const updated = await optimisticJsonUpdate(redis, key, (existing) => {
                if (existing.status !== 'PENDING_REVIEW') {
                    throw jsonrpc.FORBIDDEN(`Cannot deny a workflow in status: ${existing.status}`);
                }
                return {
                    ...existing,
                    status: 'REJECTED',
                    updatedAt: Date.now(),
                    deniedBy: callerUid || null,
                    deniedAt: Date.now(),
                    denialReason: reason || null,
                };
            });

            if (!updated) throw jsonrpc.NOT_FOUND('Workflow');
            return { success: true, workflow: updated };
        },

        /**
         * Restore a workflow out of DELETED, REJECTED, or DEPRECATED (P1: reactivating a
         * deprecated workflow uses this same full-re-approval path — see deprecate() above).
         */
        async restore({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');

            const key = `${config.redis.workflowPrefix}${id}`;
            const existing = await redis.json.get(key);
            if (!existing) throw jsonrpc.NOT_FOUND('Workflow');

            if (existing.status === 'ACTIVE' || existing.status === 'PENDING_REVIEW') {
                return { success: true, message: `Already in ${existing.status}` };
            }

            // C5: restore goes back to PENDING_REVIEW — never directly to ACTIVE.
            // Prevents deleted/rejected/deprecated workflows from bypassing the approval gate.
            const updated = await optimisticJsonUpdate(redis, key, (doc) => {
                const next = {
                    ...doc,
                    status: 'PENDING_REVIEW',
                    updatedAt: Date.now(),
                    approvals: [],
                };
                // §3.1 — a fresh review cycle: drop any prior gate + cooling state so
                // re-approval opens a new gate (old signatures don't carry over).
                delete next.deletedAt;
                delete next.deprecatedAt;
                delete next.deprecatedBy;
                delete next.gateId;
                delete next.effective_at;
                return next;
            });

            if (!updated) throw jsonrpc.NOT_FOUND('Workflow');
            return { success: true, workflow: updated };
        },

        // --- CATEGORY & DISCOVERY ---

        /**
         * Get unique categories for two-step matching
         */
        async categories() {
            const ids = await redis.sMembers(config.redis.workflowIndex);
            const keys = ids.map(id => `${config.redis.workflowPrefix}${id}`);

            const categorySet = new Set();

            for (const key of keys) {
                const workflow = await redis.json.get(key);
                if (workflow && workflow.status === 'ACTIVE' && workflow.category) {
                    const val = typeof workflow.category === 'string' ? workflow.category : JSON.stringify(workflow.category);
                    categorySet.add(val);
                }
            }

            return Array.from(categorySet).map(c => {
                try { return JSON.parse(c); } catch { return c; }
            }).sort((a, b) => {
                // Simple sort for strings, try-catch for objects
                const sA =  typeof a === 'string' ? a : JSON.stringify(a);
                const sB =  typeof b === 'string' ? b : JSON.stringify(b);
                return sA.localeCompare(sB);
            });
        },

        // --- AI SNAPSHOT SYNCHRONIZATION ---

        /**
         * Build a snapshot of all active workflows for Agent service
         */
        async build() {
            const workflows = await methods.list({ includeDeleted: false, limit: 1000 });
            const items = workflows.items || [];
            
            // Transform to AI-optimized structure using Distinct
            const aiWorkflows = items.map(wf => ({
                id: wf.id,
                type: 'workflow',
                name: wf.name,
                desc: wf.desc,
                status: wf.status,   // §3.4 — lets getSnapshot trim to ACTIVE for external callers
                required_inputs: wf.required_inputs || [],
                optional_inputs: wf.optional_inputs || [],
                synonyms: wf.synonyms || {},
                examples: wf.examples || [],
                keywords: wf.keywords || [],
                tags: wf.tags || [],
                // Pre-rendered AI Metadata for LLM Efficiency
                ai_meta: Distinct.buildAiMeta(wf)
            }));

            const snapshotKey = config.redis.snapshotKey;
            await redis.set(snapshotKey, JSON.stringify(aiWorkflows));
            
            logger.info(`Built AI snapshot with ${aiWorkflows.length} workflows.`);
            
            return {
                success: true,
                count: aiWorkflows.length,
                key: snapshotKey,
                timestamp: Date.now()
            };
        },

        /**
         * Get the current AI capability snapshot
         */
        async getSnapshot({ activeOnly = false } = {}) {
            const snapshotKey = config.redis.snapshotKey;
            const data = await redis.get(snapshotKey);
            if (!data) return { items: [], timestamp: null };

            try {
                let items = JSON.parse(data);
                // §3.4 — external (non-admin) discovery sees only ACTIVE capabilities,
                // never pending proposals (those leak in-flight submissions). Legacy
                // snapshots without a status field are treated as ACTIVE (back-compat).
                if (activeOnly) items = items.filter(i => !i.status || i.status === 'ACTIVE');
                return {
                    items,
                    timestamp: Date.now()
                };
            } catch (e) {
                logger.error('Failed to parse snapshot:', e);
                return { items: [], timestamp: null };
            }
        },

        /**
         * §3.3 — fetch an immutable version snapshot (for the approval-review diff).
         * Without `version`, returns the current version number; with it, the
         * snapshot of that version (or NOT_FOUND).
         */
        async getVersion({ id, version } = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            if (version === undefined || version === null) {
                const cur = await redis.json.get(`${config.redis.workflowPrefix}${id}`);
                if (!cur) throw jsonrpc.NOT_FOUND('Workflow');
                return { id, currentVersion: cur.version || 1 };
            }
            const snap = await redis.json.get(versionKey(id, version));
            if (!snap) throw jsonrpc.NOT_FOUND(`Workflow version ${version}`);
            return snap;
        }
    };

    return methods;
};
