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
            variables:   { type: 'array',    description: 'Declared variable names (e.g. ["name","code"])' },
            description: { type: 'string',   description: 'Purpose of this template' },
            status:      { type: 'enum',     options: ['ACTIVE', 'DELETED'], description: 'Template status' },
            createdAt:   { type: 'datetime', description: 'Creation timestamp' },
            updatedAt:   { type: 'datetime', description: 'Last update timestamp' }
        }
    },

    sms_template: {
        name: 'sms_template',
        description: 'SMS template mapping to provider-approved template codes',
        fields: {
            id:           { type: 'string',   description: 'Unique identifier', required: true },
            name:         { type: 'string',   description: 'Template name (e.g. verify_code)', required: true },
            channel:      { type: 'enum',     options: ['aliyun', 'twilio', 'mock'], description: 'SMS provider channel', required: true },
            providerCode: { type: 'string',   description: 'Provider-side template code (pre-approved)', required: true },
            variables:    { type: 'array',    description: 'Declared variable names (e.g. ["code","minutes"])' },
            description:  { type: 'string',   description: 'Purpose of this template' },
            status:       { type: 'enum',     options: ['ACTIVE', 'DELETED'], description: 'Template status' },
            createdAt:    { type: 'datetime', description: 'Creation timestamp' },
            updatedAt:    { type: 'datetime', description: 'Last update timestamp' }
        }
    }
};
