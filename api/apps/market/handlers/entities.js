module.exports = {
    "shipment": {
        description: "A shipment created after a payment is collected/settled",
        softDelete: false,
        fields: {
            "id":         { type: "string", description: "Unique identifier", required: true },
            "orderId":    { type: "string", description: "Associated order id" },
            "paymentId":  { type: "string", description: "Payment that triggered this shipment" },
            "address":    { type: "string", description: "Ship-to address (free text for the fixture)" },
            "state":      { type: "enum", options: ["CREATED", "SHIPPED"], description: "Business lifecycle (separate from factory ACTIVE/DELETED status)" },
            "trackingNo": { type: "string", description: "Carrier tracking number (assigned on ship)" },
            "shippedAt":  { type: "datetime", description: "When shipped (null until then)" },
            "createdAt":  { type: "datetime", description: "Creation timestamp" }
        }
    },
    "order": {
        description: "A market order that must be paid, then AML-cleared, before it advances",
        softDelete: false,
        fields: {
            "id":          { type: "string", description: "Unique identifier", required: true },
            "orderRef":    { type: "string", description: "External/business order reference (free text)" },
            "amount":      { type: "number", description: "Order amount (minor units or decimal)" },
            "currency":    { type: "string", description: "ISO currency code" },
            "state":       { type: "enum", options: ["PLACED", "PAID", "CONFIRMED", "HELD"], description: "Business lifecycle (separate from factory ACTIVE/DELETED status)" },
            "paidAt":      { type: "datetime", description: "When payment was collected (null until paid)" },
            "confirmedAt": { type: "datetime", description: "When AML-cleared/confirmed (null until then)" },
            "heldAt":      { type: "datetime", description: "When AML-held (null unless held)" },
            "holdReason":  { type: "string", description: "Why held (null unless held)" },
            "createdAt":   { type: "datetime", description: "Creation timestamp" }
        }
    }
};
