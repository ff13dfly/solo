const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const createEntity = require('../../../library/entity');
const jsonrpc = require('../handlers/jsonrpc');

/**
 * Multi-signature approval gate (VERSION.md §3.1 — high-risk 多签档).
 *
 * @why  The C1 fast lane (orchestrator's single-click flip) is fine for read-only
 *       workflows. A workflow that WRITES (money/identity/sensitive services) routes
 *       here: m-of-n approvers must each Ed25519-SIGN the workflow's definition digest
 *       before it activates. The signature — not "uid X clicked" — is the binding:
 *       it ties a specific human's key to a specific (workflowId, version, definition).
 *
 * Trust model (single domain, VERSION.md): orchestrator (trusted infra) asserts
 * approverUid/submitterUid from the authenticated session; the SIGNATURE is the proof
 * of authority (verified against approverUid's published public key via user.key.public,
 * including retired keys). Self-approval is banned. Expired gates fail closed.
 *
 * State: OPEN → APPROVED (m signatures) | REJECTED (human) | EXPIRED (deadline).
 * Gate stored via Entity Factory; SAP `state` field (Factory reserves `status`).
 */
const STATE = { OPEN: 'OPEN', APPROVED: 'APPROVED', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED' };

module.exports = (redis, { config, relay }) => {
    const gates = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'gate',
        idLength: (config.idLengths && config.idLengths.gate) || 12,
        softDelete: true,
        searchFields: ['subject', 'state'],
    });

    // Verify a signature against the approver's CURRENT or any RETIRED public key.
    function verifyAgainst(digest, signatureBs58, publicKeys) {
        let sig;
        try { sig = bs58.decode(signatureBs58); } catch { return false; }
        const msg = Buffer.from(digest, 'utf8');
        return publicKeys.some((pk) => {
            try { return nacl.sign.detached.verify(msg, sig, bs58.decode(pk)); } catch { return false; }
        });
    }

    // Lazily flip an OPEN-but-past-deadline gate to EXPIRED (fail-closed read).
    async function settleExpiry(gate) {
        if (gate.state === STATE.OPEN && gate.expiresAt && Date.now() > gate.expiresAt) {
            return gates.update({ id: gate.id, state: STATE.EXPIRED });
        }
        return gate;
    }

    return {
        /**
         * Open a fresh multi-sig gate. Orchestrator calls this once per approval cycle
         * and stores the returned id on the workflow.
         */
        async open({ subject, digest, requiredSigners = 1, expiresInSec, submitterUid = null } = {}) {
            if (!subject) throw jsonrpc.MISSING_PARAM('subject');
            if (!digest || !/^[0-9a-f]{16,128}$/i.test(digest)) throw jsonrpc.INVALID_PARAM('digest must be a hex string');
            const required = Math.max(1, parseInt(requiredSigners, 10) || 1);
            const ttl = parseInt(expiresInSec, 10) || (config.gate && config.gate.defaultExpirySec) || 259200; // 72h

            return gates.create({
                subject,
                digest,
                requiredSigners: required,
                submitterUid,
                signers: [],
                state: STATE.OPEN,
                expiresAt: Date.now() + ttl * 1000,
                approvedAt: null,
            });
        },

        /**
         * Accept one approver's signature. Verifies it against their published key,
         * bans self-approval + duplicates, accumulates; flips APPROVED at the threshold.
         */
        async sign({ id, approverUid, signature } = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            if (!approverUid) throw jsonrpc.MISSING_PARAM('approverUid');
            if (!signature) throw jsonrpc.MISSING_PARAM('signature');

            let gate = await gates.get({ id });
            gate = await settleExpiry(gate);
            if (gate.state === STATE.EXPIRED) throw jsonrpc.FORBIDDEN('Approval gate has expired');
            if (gate.state !== STATE.OPEN) throw jsonrpc.FORBIDDEN(`Gate is ${gate.state}, not OPEN`);

            // Self-approval ban (submitter cannot sign their own workflow).
            if (gate.submitterUid && approverUid === gate.submitterUid) {
                throw jsonrpc.FORBIDDEN('Submitter cannot sign their own approval');
            }
            // Dedupe: each approver counts once.
            if ((gate.signers || []).some((s) => s.approverUid === approverUid)) {
                throw jsonrpc.FORBIDDEN('This approver has already signed');
            }

            // Fetch the approver's public key (+ retired keys) and verify the signature
            // binds them to THIS gate's digest. Approval is the verification authority.
            let pub;
            try {
                pub = await relay.call('user.key.public', { uid: approverUid });
            } catch (e) {
                throw jsonrpc.INTERNAL_ERROR(`Could not fetch approver public key: ${e.message}`);
            }
            const keys = [pub && pub.publicKey, ...((pub && pub.history) || [])].filter(Boolean);
            if (keys.length === 0) throw jsonrpc.FORBIDDEN('Approver has no signing key');
            if (!verifyAgainst(gate.digest, signature, keys)) {
                throw (jsonrpc.INVALID_SIGNATURE ? jsonrpc.INVALID_SIGNATURE('Signature does not verify against approver key')
                                                 : jsonrpc.FORBIDDEN('Signature does not verify'));
            }

            const signers = [...(gate.signers || []), {
                approverUid,
                signature,
                publicKey: keys[0],
                signedAt: Date.now(),
            }];
            const reachedThreshold = signers.length >= gate.requiredSigners;
            const next = {
                id,
                signers,
                state: reachedThreshold ? STATE.APPROVED : STATE.OPEN,
                approvedAt: reachedThreshold ? Date.now() : null,
            };
            const updated = await gates.update(next);
            return { id, state: updated.state, signed: signers.length, required: gate.requiredSigners };
        },

        /** Human reject. */
        async reject({ id, reason = null, byUid = null } = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const gate = await gates.get({ id });
            if (gate.state !== STATE.OPEN) throw jsonrpc.FORBIDDEN(`Gate is ${gate.state}, not OPEN`);
            return gates.update({ id, state: STATE.REJECTED, rejectReason: reason, rejectedBy: byUid, rejectedAt: Date.now() });
        },

        async get({ id } = {}) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const gate = await gates.get({ id });
            return settleExpiry(gate);
        },

        async list({ subject, state, limit, offset } = {}) {
            const filter = (g) => {
                if (subject && g.subject !== subject) return false;
                if (state && g.state !== state) return false;
                return true;
            };
            return gates.list({ limit, offset, filter });
        },
    };
};

module.exports.STATE = STATE;
