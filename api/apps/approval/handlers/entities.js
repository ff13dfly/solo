const { STATUS } = require('../../../library/constants');

module.exports = {
    "record": {
        description: "Approval record (SAP): a gated change intent plus its state machine and evidence trail",
        softDelete: true,
        sensitiveFields: [],
        fields: {
            "id":          { type: "string",   description: "Approval record ID", required: true },
            "target":      { type: "string",   description: "Target entity expression (service:entity:id)", required: true },
            "payload":     { type: "array",    description: "Operation[] describing the intended change (op/field/oldValue/newValue/meta)" },
            "state":       { type: "enum",      options: ["INIT", "DISPATCHED", "PENDING", "DONE", "REJECTED", "FAILED"], description: "SAP state machine (protocol §4); distinct from lifecycle status" },
            "applicant":   { type: "string",   description: "uid of the requester" },
            "evidence":    { type: "array",    description: "Append-only attestation trail (stage/actor/payloadHash/timestamp; reserves publicKey+signature for Ed25519)" },
            "confirmedAt": { type: "datetime", description: "Confirmation timestamp" },
            "status":      { type: "enum",      options: [STATUS.ACTIVE, STATUS.DELETED], description: "Lifecycle status (entity-factory soft delete)" },
            "createdAt":   { type: "datetime", description: "Creation timestamp" },
            "updatedAt":   { type: "datetime", description: "Last update timestamp" }
        }
    },
    "gate": {
        description: "Multi-signature approval gate (§3.1): m-of-n approver Ed25519 signatures over a workflow definition digest",
        softDelete: true,
        sensitiveFields: [],
        fields: {
            "id":              { type: "string",   description: "Gate ID", required: true },
            "subject":         { type: "string",   description: "What is being approved (e.g. workflow:{id}:v{n})", required: true },
            "digest":          { type: "string",   description: "Hex digest of the definition each approver signs" },
            "requiredSigners": { type: "integer",  description: "m — signatures needed to reach APPROVED" },
            "submitterUid":    { type: "string",   description: "uid of the workflow submitter (self-approval ban)" },
            "signers":         { type: "array",    description: "Accumulated { approverUid, signature, publicKey, signedAt }" },
            "state":           { type: "enum",      options: ["OPEN", "APPROVED", "REJECTED", "EXPIRED"], description: "Gate state machine" },
            "expiresAt":       { type: "datetime", description: "Deadline; an OPEN gate past it fails closed (EXPIRED)" },
            "approvedAt":      { type: "datetime", description: "When the threshold was reached" },
            "status":          { type: "enum",      options: [STATUS.ACTIVE, STATUS.DELETED], description: "Lifecycle status (entity-factory soft delete)" },
            "createdAt":       { type: "datetime", description: "Creation timestamp" },
            "updatedAt":       { type: "datetime", description: "Last update timestamp" }
        }
    }
};
