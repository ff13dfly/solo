module.exports = {
    smtp: {
        name: 'smtp',
        description: 'SMTP account configuration for outbound email delivery',
        fields: {
            id:          { type: 'string',   description: 'Unique identifier', required: true },
            name:        { type: 'string',   description: 'Display name for this account', required: true },
            host:        { type: 'string',   description: 'SMTP server hostname', required: true },
            port:        { type: 'number',   description: 'SMTP server port (e.g. 465, 587)' },
            secure:      { type: 'boolean',  description: 'Use TLS (true for port 465)' },
            user:        { type: 'string',   description: 'Auth username / email address', required: true },
            from:        { type: 'string',   description: 'Default sender address (e.g. noreply@example.com)', required: true },
            status:      { type: 'enum',     options: ['ACTIVE', 'DELETED'], description: 'Account status' },
            createdAt:   { type: 'datetime', description: 'Creation timestamp' },
            updatedAt:   { type: 'datetime', description: 'Last update timestamp' }
            // pass is intentionally omitted — encrypted at rest, never exposed in UI
        }
    },

    email_template: {
        name: 'email_template',
        description: 'Email content template with variable interpolation ({{variable}})',
        fields: {
            id:          { type: 'string',   description: 'Unique identifier', required: true },
            name:        { type: 'string',   description: 'Template name (e.g. welcome, reset_password)', required: true },
            subject:     { type: 'string',   description: 'Email subject line, supports {{variable}}', required: true },
            html:        { type: 'string',   description: 'HTML body, supports {{variable}}', required: true },
            text:        { type: 'string',   description: 'Plain-text body (text/plain part), supports {{variable}}. Omitted → derived from html' },
            variables:   { type: 'array',    description: 'Declared variable names (e.g. ["name","code"])' },
            description: { type: 'string',   description: 'Purpose of this template' },
            status:      { type: 'enum',     options: ['ACTIVE', 'DELETED'], description: 'Template status' },
            createdAt:   { type: 'datetime', description: 'Creation timestamp' },
            updatedAt:   { type: 'datetime', description: 'Last update timestamp' }
        }
    },

    delivery: {
        name: 'delivery',
        description: 'Queryable record of one outbound send attempt (email / sms / webhook). Written best-effort — an audit row never fails a delivery the provider accepted.',
        fields: {
            id:                { type: 'string',   description: 'Unique identifier', required: true },
            channel:           { type: 'enum',     options: ['email', 'sms', 'webhook'], description: 'Outbound channel', required: true },
            target:            { type: 'string',   description: 'Recipient — email address(es), phone, or webhook URL', required: true },
            provider:          { type: 'string',   description: "Provider that handled it: smtp|api|aliyun|twilio|webhook|mock (null when it failed before reaching one). 'mock' = nothing actually left the system" },
            deliveryStatus:    { type: 'enum',     options: ['SENT', 'MOCKED', 'FAILED', 'DELIVERED', 'BOUNCED', 'COMPLAINED'], description: 'Attempt outcome (SENT/MOCKED/FAILED) — receipts advance SENT to DELIVERED/BOUNCED/COMPLAINED via gateway.delivery.update. Distinct from `status`, which is the entity lifecycle', required: true },
            templateId:        { type: 'string',   description: 'Template used, if any' },
            subject:           { type: 'string',   description: 'Email subject (email channel only)' },
            providerMessageId: { type: 'string',   description: "Provider-side message id (Aliyun BizId / Twilio sid / SMTP messageId / 'wh-<ts>')" },
            idempotencyKey:    { type: 'string',   description: 'Caller-supplied de-dup key, if any' },
            error:             { type: 'string',   description: 'Failure reason (deliveryStatus=FAILED), truncated to 500 chars' },
            receiptAt:         { type: 'datetime', description: 'When the receipt (delivered/bounce/complaint) was recorded via delivery.update' },
            receiptDetail:     { type: 'string',   description: 'Provider-side receipt detail (bounce reason etc.), truncated to 500 chars' },
            status:            { type: 'enum',     options: ['ACTIVE', 'DELETED'], description: 'Entity lifecycle (NOT the delivery outcome — see deliveryStatus)' },
            createdAt:         { type: 'datetime', description: 'Creation timestamp' },
            updatedAt:         { type: 'datetime', description: 'Last update timestamp' }
        }
    },

    sms_template: {
        name: 'sms_template',
        description: 'SMS template mapping to provider-approved template codes',
        fields: {
            id:           { type: 'string',   description: 'Unique identifier', required: true },
            name:         { type: 'string',   description: 'Template name (e.g. verify_code)', required: true },
            channel:      { type: 'enum',     options: ['aliyun', 'twilio', 'mock'], description: 'SMS provider channel', required: true },
            providerCode: { type: 'string',   description: 'Provider-side template code (pre-approved). Aliyun: TemplateCode · Twilio: Content SID (HX…)', required: true },
            variables:    { type: 'array',    description: 'Declared variable names (e.g. ["code","minutes"])' },
            variableOrder:{ type: 'array',    description: 'Named→positional order for Twilio ContentVariables ({"1":…}). Required for the twilio channel; ignored by aliyun' },
            description:  { type: 'string',   description: 'Purpose of this template' },
            status:       { type: 'enum',     options: ['ACTIVE', 'DELETED'], description: 'Template status' },
            createdAt:    { type: 'datetime', description: 'Creation timestamp' },
            updatedAt:    { type: 'datetime', description: 'Last update timestamp' }
        }
    }
};
