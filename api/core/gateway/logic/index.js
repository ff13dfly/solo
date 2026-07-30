const rmbg = require('./rmbg');
const emailProvider = require('./email');
const smsProvider = require('./sms');
const webhookProvider = require('./webhook');
const { createSmtpEntity, getTransporter } = require('./smtp');
const EntityFactory = require('../../../library/entity');
const { insert } = require('../../../library/logger');
const clock = require('../../../library/clock');
const jsonrpc = require('../../../library/jsonrpc');
const { createDeliveryLedger } = require('./delivery');
const { fetchAttachments } = require('./attachments');
const probe = require('./probe');
const { PATTERNS } = require('../../../library/validate');

// E.164 — Twilio (and most non-Chinese carriers) reject anything else. Aliyun accepts
// domestic bare numbers, so this is applied per-provider, not globally.
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Fill {{var}} placeholders.
 *
 * @attention Two deliberate failure modes (both were silent before):
 *   - a missing/non-string template field (Entity Factory does NOT enforce entities.js
 *     `required`, so a template can be created without `html`) → INVALID_PARAMS naming
 *     the field, instead of `undefined.replace is not a function` deep in a stack.
 *   - `strict:true` → an undeclared/omitted variable is an error rather than shipping a
 *     literal `{{code}}` to the recipient. Default stays permissive (v1.1.x = only-add).
 */
function interpolate(template, variables = {}, { field = 'template', templateId, strict = false } = {}) {
    if (typeof template !== 'string') {
        throw jsonrpc.INVALID_PARAMS(
            `Template ${templateId || '?'} is incomplete: '${field}' is ${template === undefined ? 'missing' : typeof template}`
        );
    }
    const missing = [];
    const out = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const v = variables[key];
        if (v === undefined || v === null) { missing.push(key); return `{{${key}}}`; }
        return v;
    });
    if (strict && missing.length) {
        throw jsonrpc.INVALID_PARAMS(
            `Template ${templateId || '?'} '${field}': missing variables [${[...new Set(missing)].join(', ')}]`
        );
    }
    return out;
}

/**
 * Minimal plain-text sibling for an HTML body. Not a full converter — enough that a
 * text/plain reader sees prose instead of markup (and that spam filters see a text part).
 */
function htmlToText(html) {
    if (typeof html !== 'string') return html;
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Entity Factory spreads caller params verbatim and does NOT enforce the `required` flags
 * declared in entities.js (see docs/planning/return-contract-debt.md). Templates are the
 * one place where that bites at a distance: the omission surfaces as a crash inside
 * interpolate() at SEND time, on a retry loop, far from the create call that caused it.
 *
 * @param required fields that must be present & non-blank (create); pass [] for update,
 *                 where only the fields actually being written are checked.
 */
function assertTemplateFields(params = {}, required = [], entity = 'template') {
    for (const f of required) {
        if (typeof params[f] !== 'string' || params[f].trim() === '') {
            throw jsonrpc.INVALID_PARAMS(`${entity}: '${f}' is required and must be a non-empty string`);
        }
    }
    // Present-but-wrong-type is rejected on both create and update.
    for (const f of ['name', 'subject', 'html', 'text', 'providerCode', 'channel', 'description']) {
        if (params[f] !== undefined && typeof params[f] !== 'string') {
            throw jsonrpc.INVALID_PARAMS(`${entity}: '${f}' must be a string`);
        }
    }
    for (const f of ['variables', 'variableOrder']) {
        if (params[f] !== undefined && !Array.isArray(params[f])) {
            throw jsonrpc.INVALID_PARAMS(`${entity}: '${f}' must be an array of variable names`);
        }
    }
}

/** Reject obviously-malformed recipients BEFORE burning a provider call / a retry cycle. */
function assertEmailAddress(to) {
    const list = Array.isArray(to) ? to : [to];
    if (!list.length) throw jsonrpc.INVALID_PARAMS("'to' must not be empty");
    for (const addr of list) {
        if (typeof addr !== 'string' || !PATTERNS.email.test(addr.trim())) {
            throw jsonrpc.INVALID_PARAMS(`'to' is not a valid email address: ${String(addr).slice(0, 64)}`);
        }
    }
}

function assertPhoneNumber(phone, channel) {
    if (typeof phone !== 'string' || !PATTERNS.phone.test(phone.trim())) {
        throw jsonrpc.INVALID_PARAMS(`'phone' is not a valid phone number: ${String(phone).slice(0, 32)}`);
    }
    // Aliyun takes domestic bare numbers; Twilio requires E.164.
    if (channel === 'twilio' && !E164.test(phone.trim())) {
        throw jsonrpc.INVALID_PARAMS(`'phone' must be E.164 (+countrycode…) for the twilio channel: ${phone}`);
    }
}

function createLogic(redisClient, options = {}) {
    const { config = {}, logger, relay = null } = options;
    const emailCfg = config.email || {};
    const smsCfg = config.sms || {};
    // OFF by default = v1.1.x only-add. ON: an omitted {{var}} is an error instead of
    // shipping the literal placeholder to the recipient (GATEWAY_STRICT_VARIABLES=true).
    const strictVars = config.strictVariables === true;
    const attachCfg = config.attachments || {};

    // --- Entity Factories ---
    const smtpEntity = createSmtpEntity(redisClient);

    const emailTemplateEntity = EntityFactory(redisClient, {
        serviceName: 'gateway',
        entityName: 'email_template',
        searchFields: ['name', 'subject', 'description']
    });

    const smsTemplateEntity = EntityFactory(redisClient, {
        serviceName: 'gateway',
        entityName: 'sms_template',
        searchFields: ['name', 'description']
    });

    // Queryable ledger + idempotency + `_event` piggyback for every outbound send.
    // relay (system.gateway bot, optional) adds: FAILED events via event.emit + attachments.
    const ledger = createDeliveryLedger(redisClient, { logger, relay });

    return {
        // --- CONNECTIVITY & DIAGNOSTICS ---
        gateway: {
            echo: async (params) => ({ echo: params })
        },

        // --- SMTP ACCOUNT MANAGEMENT ---
        smtp: {
            create: async (params) => smtpEntity.create(params),
            get:    async (params) => smtpEntity.get(params),
            list:   async (params) => smtpEntity.list(params),
            update: async (params) => smtpEntity.update(params),
            delete: async (params) => smtpEntity.delete(params),

            test: async ({ id }) => {
                const cfg = await smtpEntity.getDecrypted(id);
                await getTransporter(cfg, id);
                return { success: true, message: 'SMTP connection verified' };
            }
        },

        // --- NOTIFICATION CHANNELS ---
        email: {
            template: {
                // Entity Factory does not enforce entities.js `required`, so the two fields
                // that later feed interpolate() are checked here — a template missing them
                // is only discoverable at SEND time otherwise (and by then it's a retry storm).
                create: async (params) => {
                    assertTemplateFields(params, ['name', 'subject', 'html'], 'email_template');
                    return emailTemplateEntity.create(params);
                },
                get:    async (params) => emailTemplateEntity.get(params),
                list:   async (params) => emailTemplateEntity.list(params),
                update: async (params) => {
                    assertTemplateFields(params, [], 'email_template');   // only what's present
                    return emailTemplateEntity.update(params);
                },
                delete: async (params) => emailTemplateEntity.delete(params)
            },

            send: async (params) => {
                const { templateId, variables, smtpId, to, subject, content, html, cc, bcc, replyTo } = params;

                let resolvedSubject = subject;
                let resolvedHtml = html;
                let resolvedContent = content;

                if (templateId) {
                    const tpl = await emailTemplateEntity.get({ id: templateId });
                    const opts = { templateId, strict: strictVars };
                    resolvedSubject = interpolate(tpl.subject, variables, { ...opts, field: 'subject' });
                    resolvedHtml = interpolate(tpl.html, variables, { ...opts, field: 'html' });
                    // A template MAY carry a plain-text sibling; else derive one. Shipping HTML
                    // source as the text/plain part is what happened before.
                    resolvedContent = typeof tpl.text === 'string'
                        ? interpolate(tpl.text, variables, { ...opts, field: 'text' })
                        : htmlToText(resolvedHtml);
                }

                assertEmailAddress(to);
                for (const [field, v] of [['cc', cc], ['bcc', bcc], ['replyTo', replyTo]]) {
                    if (v !== undefined && v !== null) {
                        try { assertEmailAddress(v); }
                        catch (e) { throw jsonrpc.INVALID_PARAMS(String(e.message).replace(/'to'/, `'${field}'`)); }
                    }
                }

                // Attachments are storage REFERENCES ({assetId, filename?}) resolved via the
                // gateway relay bot — fetched BEFORE ledger.run so a bad reference fails fast
                // (no ledger row, no idempotency claim, no provider call).
                let attachments = null;
                if (Array.isArray(params.attachments) && params.attachments.length) {
                    if (!relay) {
                        throw jsonrpc.INVALID_PARAMS(
                            'attachments require the gateway relay bot (system.gateway / RELAY:TOKEN:gateway) — not provisioned on this deployment'
                        );
                    }
                    try {
                        attachments = await fetchAttachments(relay, params.attachments, attachCfg);
                    } catch (e) {
                        throw jsonrpc.INVALID_PARAMS(`attachments: ${e.message}`);
                    }
                }

                const result = await ledger.run({
                    channel: 'email',
                    target: Array.isArray(to) ? to.join(',') : to,
                    templateId,
                    subject: resolvedSubject,
                    idempotencyKey: params.idempotencyKey,
                    send: async () => {
                        if (smtpId) {
                            const cfg = await smtpEntity.getDecrypted(smtpId);
                            const transporter = await getTransporter(cfg, smtpId);
                            const info = await transporter.sendMail({
                                from: cfg.from,
                                to,
                                ...(cc ? { cc } : {}),
                                ...(bcc ? { bcc } : {}),
                                ...(replyTo ? { replyTo } : {}),
                                subject: resolvedSubject,
                                text: resolvedContent,
                                html: resolvedHtml || resolvedContent,
                                ...(attachments ? { attachments } : {})
                            });
                            return { success: true, messageId: info.messageId, provider: 'smtp' };
                        }
                        const channel = emailProvider.resolveChannel(emailCfg);
                        logger.info(`email.send via ${channel} → ${to}`);
                        return emailProvider.send(emailCfg, {
                            to, cc, bcc, replyTo,
                            subject: resolvedSubject,
                            content: resolvedContent,
                            html: resolvedHtml,
                            attachments
                        });
                    },
                });

                logger.info(`email sent: ${result.messageId}`);
                insert(`email:${to}`, {
                    op: 'email.send',
                    stamp: clock.now(),
                    from: smtpId ? `smtp:${smtpId}` : emailCfg.from,
                    to,
                    subject: resolvedSubject,
                    templateId: templateId || null,
                    messageId: result.messageId,
                    channel: result.provider,
                    status: 'sent'
                });
                return result;
            }
        },

        sms: {
            template: {
                create: async (params) => {
                    assertTemplateFields(params, ['name', 'channel', 'providerCode'], 'sms_template');
                    return smsTemplateEntity.create(params);
                },
                get:    async (params) => smsTemplateEntity.get(params),
                list:   async (params) => smsTemplateEntity.list(params),
                update: async (params) => {
                    assertTemplateFields(params, [], 'sms_template');
                    return smsTemplateEntity.update(params);
                },
                delete: async (params) => smsTemplateEntity.delete(params)
            },

            send: async (params) => {
                const { templateId, phone, variables } = params;

                if (!templateId) throw jsonrpc.MISSING_PARAM('templateId');

                const tpl = await smsTemplateEntity.get({ id: templateId });
                const channel = tpl.channel || smsProvider.resolveChannel(smsCfg);

                assertPhoneNumber(phone, channel);
                // strict mode: a declared variable with no value would ship as a literal
                // `{{code}}` inside a carrier-approved template (OTP's worst failure).
                if (strictVars && Array.isArray(tpl.variables)) {
                    const missing = tpl.variables.filter((k) => (variables || {})[k] === undefined);
                    if (missing.length) {
                        throw jsonrpc.INVALID_PARAMS(`Template ${templateId}: missing variables [${missing.join(', ')}]`);
                    }
                }

                logger.info(`sms.send via ${channel} → ${phone}`);
                const result = await ledger.run({
                    channel: 'sms',
                    target: phone,
                    templateId,
                    idempotencyKey: params.idempotencyKey,
                    send: () => smsProvider.send(
                        { ...smsCfg, channel },
                        {
                            phone,
                            templateCode: tpl.providerCode,
                            variables,
                            // Twilio content templates key variables POSITIONALLY ({"1":…}); the
                            // template declares the named→positional order.
                            variableOrder: tpl.variableOrder,
                        }
                    ),
                });
                logger.info(`sms sent: ${result.messageId}`);

                insert(`sms:${phone}`, {
                    op: 'sms.send',
                    stamp: clock.now(),
                    phone,
                    templateId,
                    messageId: result.messageId,
                    channel: result.provider,
                    status: 'sent'
                });
                return result;
            }
        },

        // --- OUTBOUND WEBHOOK (machine targets — third-party endpoints) ---
        webhook: {
            send: async (params) => {
                const { url, payload, type, targetId, secret, timeoutMs } = params;
                if (!url) throw jsonrpc.MISSING_PARAM('url');
                logger.info(`webhook.send → ${url}`);
                const result = await ledger.run({
                    channel: 'webhook',
                    target: url,
                    idempotencyKey: params.idempotencyKey,
                    send: () => webhookProvider.send({ url, payload, type, targetId, secret, timeoutMs }),
                });
                insert(`webhook:${url}`, {
                    op: 'webhook.send',
                    stamp: clock.now(),
                    url,
                    type: type || 'notification',
                    status: result.status,
                    messageId: result.messageId
                });
                return result;
            }
        },

        // --- DELIVERY LEDGER (queryable record of what actually went out) ---
        delivery: {
            get:    async (params) => ledger.get(params),
            list:   async (params) => ledger.list(params),
            // Receipt flow-back: SENT → DELIVERED/BOUNCED/COMPLAINED (see delivery.js update()).
            update: async (params) => ledger.update(params)
        },

        // --- CHANNEL PROBES (credentials wired? — read-only, sends nothing) ---
        channel: {
            test: async (params) => probe.testChannel(params, { emailCfg, smsCfg })
        },

        // --- IMAGE PROCESSING ---
        rmbg: {
            cutout: rmbg.cutout
        }
    };
}

module.exports = createLogic;
