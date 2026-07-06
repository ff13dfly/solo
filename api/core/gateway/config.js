require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
  serviceName: process.env.SERVICE_NAME || 'gateway',
  category: 'system',
  version: pkg.version || '0.1.0',
    port: portFor('gateway', 8020),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',
    linkTimeout: 24 * 60 * 60 * 1000, // 24 hours

    bodyLimit: process.env.BODY_LIMIT || '20mb',
    debug: process.env.DEBUG === 'true' || true,
    
    // Redis 存储配置
    redis: {
        semanticPrefix: 'SYSTEM:SEMANTIC:',
        categoryConfigPrefix: 'CONFIG:CATEGORY:'
    },
    
    // Email — channel: 'auto' | 'smtp' | 'api' | 'mock'
    // auto: uses 'api' if EMAIL_API_KEY is set, 'smtp' if EMAIL_SMTP_HOST is set, else 'mock'
    email: {
        channel: process.env.EMAIL_CHANNEL || 'auto',
        from: process.env.EMAIL_FROM || 'noreply@example.com',
        smtp: {
            host: process.env.EMAIL_SMTP_HOST || '',
            port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
            secure: process.env.EMAIL_SMTP_SECURE === 'true',
            user: process.env.EMAIL_SMTP_USER || '',
            pass: process.env.EMAIL_SMTP_PASS || ''
        },
        api: {
            key: process.env.EMAIL_API_KEY || '',
            url: process.env.EMAIL_API_URL || 'https://api.resend.com/emails'
        }
    },

    // Encryption key for sensitive entity fields (SMTP pass, etc.)
    secretKey: process.env.GATEWAY_SECRET_KEY || '',

    // SMS — channel: 'auto' | 'aliyun' | 'twilio' | 'mock'
    sms: {
        channel: process.env.SMS_CHANNEL || 'auto',
        aliyun: {
            accessKeyId: process.env.SMS_ALIYUN_KEY_ID || '',
            accessKeySecret: process.env.SMS_ALIYUN_KEY_SECRET || '',
            signName: process.env.SMS_ALIYUN_SIGN_NAME || 'Solo·AI',
            endpoint: process.env.SMS_ALIYUN_ENDPOINT || 'https://dysmsapi.aliyuncs.com'
        },
        twilio: {
            accountSid: process.env.SMS_TWILIO_SID || '',
            authToken: process.env.SMS_TWILIO_TOKEN || '',
            from: process.env.SMS_TWILIO_FROM || ''
        }
    },

    // Semantic description for Router discovery and Portal UI
    description: {
        name: 'gateway',
        desc: 'External communication gateway service for email, SMS, and third-party API integration',
        category: 'system',
        keywords: ['email', 'sms', 'notification', 'external'],
        en: {
            main: [
                'external communication gateway for email, SMS, and third-party integrations',
                'manages SMTP accounts, email templates, and SMS templates',
                'routes outbound messages through configurable provider channels'
            ],
            methods: {
                'ping': ['health check'],
                'entities': ['get entity schema definitions'],
                'gateway.smtp.create': ['add a new SMTP account (password encrypted at rest)'],
                'gateway.smtp.get': ['retrieve SMTP account by ID'],
                'gateway.smtp.list': ['list all SMTP accounts'],
                'gateway.smtp.update': ['update SMTP account fields'],
                'gateway.smtp.delete': ['delete SMTP account'],
                'gateway.smtp.test': ['verify SMTP connection for an account'],
                'gateway.email.template.create': ['create a new email template'],
                'gateway.email.template.get': ['get email template by ID'],
                'gateway.email.template.list': ['list email templates'],
                'gateway.email.template.update': ['update email template'],
                'gateway.email.template.delete': ['delete email template'],
                'gateway.email.send': ['send email directly or via template'],
                'gateway.sms.template.create': ['create a new SMS template'],
                'gateway.sms.template.get': ['get SMS template by ID'],
                'gateway.sms.template.list': ['list SMS templates'],
                'gateway.sms.template.update': ['update SMS template'],
                'gateway.sms.template.delete': ['delete SMS template'],
                'gateway.sms.send': ['send SMS via stored template']
            }
        },
        zh: {
            main: [
                '对外通信网关，统一管理邮件、短信及第三方 API 集成',
                '维护 SMTP 账号、邮件模版和短信模版实体',
                '通过可配置的通道路由发送外部消息'
            ],
            methods: {
                'ping': ['健康检查'],
                'entities': ['获取实体 Schema 定义'],
                'gateway.smtp.create': ['新增 SMTP 账号（密码加密存储）'],
                'gateway.smtp.get': ['按 ID 获取 SMTP 账号'],
                'gateway.smtp.list': ['列出所有 SMTP 账号'],
                'gateway.smtp.update': ['更新 SMTP 账号字段'],
                'gateway.smtp.delete': ['删除 SMTP 账号'],
                'gateway.smtp.test': ['验证 SMTP 账号连通性'],
                'gateway.email.template.create': ['新建邮件模版'],
                'gateway.email.template.get': ['按 ID 获取邮件模版'],
                'gateway.email.template.list': ['列出邮件模版'],
                'gateway.email.template.update': ['更新邮件模版'],
                'gateway.email.template.delete': ['删除邮件模版'],
                'gateway.email.send': ['发送邮件（直接内容或使用模版）'],
                'gateway.sms.template.create': ['新建短信模版'],
                'gateway.sms.template.get': ['按 ID 获取短信模版'],
                'gateway.sms.template.list': ['列出短信模版'],
                'gateway.sms.template.update': ['更新短信模版'],
                'gateway.sms.template.delete': ['删除短信模版'],
                'gateway.sms.send': ['按模版发送短信']
            }
        }
    }
};
