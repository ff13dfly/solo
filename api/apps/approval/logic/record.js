const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const createEntity = require('../../../library/entity');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * SAP record logic — the approval state machine over the shared Entity Factory.
 *
 * Field mapping note: the Entity Factory reserves `status` for the ACTIVE/DELETED
 * lifecycle (soft delete), so the SAP state machine (protocol §4) is stored in a
 * separate `state` field.
 *
 * Evidence (MVP): server-attested — each transition appends { stage, actor,
 * payloadHash, timestamp, method:'server-attested' }, with publicKey/signature
 * reserved as null. When per-user Ed25519 keys exist, callers supply a real
 * signature and `method` becomes 'solana:ed25519'; verification slots in here.
 */
const STATE = {
    INIT: 'INIT',
    DISPATCHED: 'DISPATCHED',
    PENDING: 'PENDING',
    DONE: 'DONE',
    REJECTED: 'REJECTED',
    FAILED: 'FAILED',
};

// Allowed state transitions per action (MVP: confirm goes straight DISPATCHED->DONE;
// PENDING/FAILED are reserved for when system-proxy task dispatch (§8) is added).
const TRANSITIONS = {
    verify:  { from: [STATE.INIT], to: STATE.DISPATCHED },
    confirm: { from: [STATE.DISPATCHED], to: STATE.DONE },
    reject:  { from: [STATE.INIT, STATE.DISPATCHED], to: STATE.REJECTED },
};

const OPS = ['UPDATE', 'DELETE', 'ADD'];

function hashPayload(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

// The digest an approver signs at a stage. Binds the signature to EXACTLY this
// (target, stage, payloadHash) so a captured signature can't be replayed onto a
// different record, a different stage, or a mutated payload. Hex (sha256) → satisfies
// user.key.sign's [0-9a-f]{16,128} contract; a verifier recomputes it from the stored
// record. Consumers (e.g. collection.payment.refund) reproduce this exact formula.
function stageDigest(target, stage, payloadHash) {
    return crypto.createHash('sha256').update(`${target}\n${stage}\n${payloadHash}`).digest('hex');
}

// Verify an Ed25519 signature against any of the signer's keys (current + retired).
function verifyAgainst(digest, signatureBs58, publicKeys) {
    let sig;
    try { sig = bs58.decode(signatureBs58); } catch { return false; }
    const msg = Buffer.from(digest, 'utf8');
    return publicKeys.some((pk) => {
        try { return nacl.sign.detached.verify(msg, sig, bs58.decode(pk)); } catch { return false; }
    });
}

module.exports = (redis, { config, relay } = {}) => {
    const records = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'record',
        idLength: config.idLengths.record,
        softDelete: true,
        searchFields: ['target', 'state'],
    });

    function attest(stage, actor, payloadHash, { publicKey = null, signature = null } = {}) {
        return {
            stage,
            actor: actor || null,
            payloadHash,
            timestamp: Date.now(),
            method: signature ? 'solana:ed25519' : 'server-attested',
            publicKey,   // populated when a real signature is supplied + verified
            signature,
        };
    }

    // Build one evidence entry. A `signature` upgrades the entry from server-attested to
    // a verified Ed25519 attestation: the actor's published key (current OR retired) must
    // validate their signature over stageDigest(target, stage, payloadHash). No signature
    // → server-attested (backward compatible). The acting identity (`actor`) always comes
    // from the Router-verified session, never the client; the signature only proves the
    // actor authorised THIS exact content at THIS stage.
    async function signedAttest(stage, actor, target, payloadHash, signature) {
        if (!signature) return attest(stage, actor, payloadHash);
        if (!actor) throw jsonrpc.FORBIDDEN('a signed stage requires an authenticated actor');
        if (!relay) throw jsonrpc.INTERNAL_ERROR('signature verification unavailable (no relay)');
        let pub;
        try { pub = await relay.call('user.key.public', { uid: actor }); }
        catch (e) { throw jsonrpc.INTERNAL_ERROR(`could not fetch signer public key: ${e.message}`); }
        const keys = [pub && pub.publicKey, ...((pub && pub.history) || [])].filter(Boolean);
        if (!keys.length) throw jsonrpc.FORBIDDEN(`signer ${actor} has no signing key`);
        if (!verifyAgainst(stageDigest(target, stage, payloadHash), signature, keys)) {
            throw jsonrpc.INVALID_SIGNATURE();
        }
        return attest(stage, actor, payloadHash, { publicKey: keys[0], signature });
    }

    function assertOperations(payload) {
        if (!Array.isArray(payload) || payload.length === 0) {
            throw jsonrpc.INVALID_PARAM('payload must be a non-empty array of operations');
        }
        for (const op of payload) {
            if (!op || !OPS.includes(op.op)) {
                throw jsonrpc.INVALID_PARAM(`operation.op must be one of ${OPS.join('/')}`);
            }
            if (!op.field) throw jsonrpc.INVALID_PARAM('operation.field is required');
        }
    }

    function nextState(record, action) {
        const t = TRANSITIONS[action];
        if (!t.from.includes(record.state)) {
            throw jsonrpc.FORBIDDEN(`Cannot ${action} a record in state ${record.state} (expected ${t.from.join('|')})`);
        }
        return t.to;
    }

    return {
        /** Applicant files a change request → INIT. Optional Ed25519 `signature`. */
        async request({ target, payload, signature } = {}, ctx = {}) {
            if (!target) throw jsonrpc.MISSING_PARAM('target');
            assertOperations(payload);

            const applicant = ctx.actor || null;
            const entry = await signedAttest('request', applicant, target, hashPayload(payload), signature);
            return records.create({
                target,
                payload,
                state: STATE.INIT,
                applicant,
                evidence: [entry],
            });
        },

        /** Verifier approves the content → DISPATCHED. Applicant may not self-verify. */
        async verify({ id, signature } = {}, ctx = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const record = await records.get({ id });
            const to = nextState(record, 'verify');

            const actor = ctx.actor || null;
            if (actor && record.applicant && actor === record.applicant) {
                throw jsonrpc.FORBIDDEN('Applicant cannot verify their own request');
            }

            const entry = await signedAttest('verify', actor, record.target, hashPayload(record.payload), signature);
            return records.update({ id, state: to, evidence: [...(record.evidence || []), entry] });
        },

        /** Confirmer attests physical execution → DONE. Optional Ed25519 `signature`. */
        async confirm({ id, signature } = {}, ctx = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const record = await records.get({ id });
            const to = nextState(record, 'confirm');

            const actor = ctx.actor || null;
            // A 3-distinct-actor chain is the whole point — the confirmer must differ from
            // both prior signers, mirroring the self-verify ban (defense in depth; a
            // consumer like collection.payment.refund also re-checks distinct actors).
            const priorActors = new Set((record.evidence || []).map((e) => e.actor).filter(Boolean));
            if (actor && priorActors.has(actor)) {
                throw jsonrpc.FORBIDDEN('Confirmer must differ from the applicant and verifier');
            }

            const entry = await signedAttest('confirm', actor, record.target, hashPayload(record.payload), signature);
            return records.update({ id, state: to, confirmedAt: Date.now(), evidence: [...(record.evidence || []), entry] });
        },

        /** Reject a request → REJECTED. */
        async reject({ id, reason } = {}, ctx = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const record = await records.get({ id });
            const to = nextState(record, 'reject');

            const entry = { ...attest('reject', ctx.actor || null, hashPayload(record.payload)), reason: reason || null };
            const evidence = [...(record.evidence || []), entry];
            return records.update({ id, state: to, evidence });
        },

        async get({ id } = {}) {
            return records.get({ id });
        },

        async list({ target, state, limit, offset } = {}) {
            const filter = (item) => {
                if (target && item.target !== target) return false;
                if (state && item.state !== state) return false;
                return true;
            };
            return records.list({ limit, offset, filter });
        },
    };
};
