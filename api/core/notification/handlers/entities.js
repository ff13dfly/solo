const { STATUS } = require('../../../library/constants');

module.exports = {
    "message": {
        description: "Persisted system notification (inbox-addressable)",
        softDelete: false,
        fields: {
            "id":         { type: "string",   description: "Message ID", required: true },
            "targetId":   { type: "string",   description: "Recipient uid or agent_id", required: true },
            "type":       { type: "string",   description: "Message type (workflow.approved, system.alert, custom, ...)", required: true },
            "payload":    { type: "object",   description: "Caller-defined message body" },
            "sourceId":   { type: "string",   description: "Sender id (for traceability)" },
            "ref":        { type: "string",   description: "Related resource id (e.g. workflow id)" },
            "status":     { type: "enum",     options: ["unread", "read"], description: "Read state" },
            "readAt":     { type: "datetime", description: "When marked read" },
            "createdAt":  { type: "datetime", description: "Creation timestamp" }
        }
    }
};
