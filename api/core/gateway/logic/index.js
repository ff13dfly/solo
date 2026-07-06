const rmbg = require('./rmbg');
const emailProvider = require('./email');
const smsProvider = require('./sms');
const webhookProvider = require('./webhook');
const { createSmtpEntity, getTransporter } = require('./smtp');
const EntityFactory = require('../../../library/entity');
const { insert } = require('../../../library/logger');

function interpolate(template, variables = {}) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

function createLogic(redisClient, options = {}) {
    const { config = {}, logger } = options;
    const emailCfg = config.email || {};
    const smsCfg = config.sms || {};

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
                create: async (params) => emailTemplateEntity.create(params),
                get:    async (params) => emailTemplateEntity.get(params),
                list:   async (params) => emailTemplateEntity.list(params),
                update: async (params) => emailTemplateEntity.update(params),
                delete: async (params) => emailTemplateEntity.delete(params)
            },

            send: async (params) => {
                const { templateId, variables, smtpId, to, subject, content, html } = params;

                let resolvedSubject = subject;
                let resolvedHtml = html;
                let resolvedContent = content;

                if (templateId) {
                    const tpl = await emailTemplateEntity.get({ id: templateId });
                    resolvedSubject = interpolate(tpl.subject, variables);
                    resolvedHtml = interpolate(tpl.html, variables);
                    resolvedContent = resolvedHtml;
                }

                let result;

                if (smtpId) {
                    const cfg = await smtpEntity.getDecrypted(smtpId);
                    const transporter = await getTransporter(cfg, smtpId);
                    const info = await transporter.sendMail({
                        from: cfg.from,
                        to,
                        subject: resolvedSubject,
                        text: resolvedContent,
                        html: resolvedHtml || resolvedContent
                    });
                    result = { success: true, messageId: info.messageId, provider: 'smtp' };
                } else {
                    const channel = emailProvider.resolveChannel(emailCfg);
                    logger.info(`email.send via ${channel} → ${to}`);
                    result = await emailProvider.send(emailCfg, {
                        to,
                        subject: resolvedSubject,
                        content: resolvedContent,
                        html: resolvedHtml
                    });
                }

                logger.info(`email sent: ${result.messageId}`);
                insert(`email:${to}`, {
                    op: 'email.send',
                    stamp: Date.now(),
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
                create: async (params) => smsTemplateEntity.create(params),
                get:    async (params) => smsTemplateEntity.get(params),
                list:   async (params) => smsTemplateEntity.list(params),
                update: async (params) => smsTemplateEntity.update(params),
                delete: async (params) => smsTemplateEntity.delete(params)
            },

            send: async (params) => {
                const { templateId, phone, variables } = params;

                if (!templateId) throw new Error('Missing required field: templateId');

                const tpl = await smsTemplateEntity.get({ id: templateId });
                const channel = tpl.channel || smsProvider.resolveChannel(smsCfg);

                logger.info(`sms.send via ${channel} → ${phone}`);
                const result = await smsProvider.send(
                    { ...smsCfg, channel },
                    { phone, templateCode: tpl.providerCode, variables }
                );
                logger.info(`sms sent: ${result.messageId}`);

                insert(`sms:${phone}`, {
                    op: 'sms.send',
                    stamp: Date.now(),
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
                if (!url) throw new Error('Missing required field: url');
                logger.info(`webhook.send → ${url}`);
                const result = await webhookProvider.send({ url, payload, type, targetId, secret, timeoutMs });
                insert(`webhook:${url}`, {
                    op: 'webhook.send',
                    stamp: Date.now(),
                    url,
                    type: type || 'notification',
                    status: result.status,
                    messageId: result.messageId
                });
                return result;
            }
        },

        // --- IMAGE PROCESSING ---
        rmbg: {
            cutout: rmbg.cutout
        }
    };
}

module.exports = createLogic;
