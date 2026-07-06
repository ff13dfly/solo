const { STATUS } = require('../../../library/constants');

module.exports = {
    "payment": {
        description: "An incoming payment recorded by the collection service",
        softDelete: false,
        fields: {
            "id":          { type: "string", description: "Unique identifier", required: true },
            "source":      { type: "string", description: "Where the payment came from (e.g. 'stripe')" },
            "orderId":     { type: "string", description: "Associated order id" },
            "amount":      { type: "number", description: "Amount (minor units or decimal, per source)" },
            "currency":    { type: "string", description: "ISO currency code" },
            "externalRef": { type: "string", description: "External payment id (e.g. Stripe pi_xxx)" },
            "state":       { type: "enum", options: ["RECEIVED", "SETTLED", "REFUNDED"], description: "Business lifecycle (separate from the factory's ACTIVE/DELETED status)" },
            "receivedAt":  { type: "datetime", description: "When recorded" },
            "settledAt":   { type: "datetime", description: "When settled (null until then)" },
            "refundedAt":  { type: "datetime", description: "When refunded (null until then; refund is approval-gated)" },
            "createdAt":   { type: "datetime", description: "Creation timestamp" }
        }
    }
};
