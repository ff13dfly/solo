const { STATUS } = require('../../../library/constants');

module.exports = {
    "source": {
        description: "An inbound webhook source: one external integration / listener, identified by an API key",
        softDelete: false,
        fields: {
            "id":          { type: "string",  description: "Unique identifier", required: true },
            "name":        { type: "string",  description: "Unique source name; determines stream EVENT:WEBHOOK:{NAME}", required: true },
            "keyHash":     { type: "string",  description: "SHA-256 of the API key (the key itself is shown once at create/rotate, never stored)", sensitive: true },
            "enabled":     { type: "boolean", description: "When false, /ingest for this source is rejected (downstream unaffected)" },
            "dedupTtlSec": { type: "number",  description: "Dedup window in seconds (covers external retry window)" },
            "status":      { type: "enum", options: [STATUS.ACTIVE, STATUS.DELETED], description: "Entity status" },
            "lastFiredAt": { type: "datetime", description: "Last successful emit" },
            "hitCount":    { type: "number",  description: "Total accepted deliveries" },
            "dupCount":    { type: "number",  description: "Deliveries dropped as duplicates" },
            "rejectCount": { type: "number",  description: "Deliveries rejected by dataSchema, held for human review" },
            "createdAt":   { type: "datetime", description: "Creation timestamp" },
            "healthUrl":   { type: "string",  description: "Optional liveness probe URL for the external listener (GET → {status:'ok'})" },
            "dataSchema":  { type: "array",   description: "Optional field whitelist+type contract (checkParams dialect) for the data this source forwards; unset = opaque pass-through" }
        }
    }
};
