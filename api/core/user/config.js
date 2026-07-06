require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');
const safeJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

module.exports = {
  serviceName: process.env.SERVICE_NAME || 'user',
  category: 'system',
  port: portFor('user', 8710),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',

  routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
  routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',
  linkTimeout: 24 * 60 * 60 * 1000, // 24 hours
  version: pkg.version || '0.1.0',
  debug: process.env.DEBUG !== 'false',
  
  // Redis 存储配置
  redis: {
    userPrefix: 'user:',
    userNamePrefix: 'user:name:',
    userIdSet: 'user:ids',
    challengePrefix: 'challenge:',
    sessionPrefix: 'session:',
    // reverse index uid → its live session tokens, for active revocation (security.md)
    userSessionsPrefix: 'USER:SESSIONS:',
    semanticPrefix: 'SYSTEM:SEMANTIC:',
    categoryConfigPrefix: 'CONFIG:CATEGORY:',
    bot: {
      prefix: 'user:bot:',
      idsSet: 'user:bot:ids'
    },
    // Roles (authority.md) — named permit templates referenced by internal users AND
    // external passports. Assigning a role MATERIALIZES its permit onto the principal;
    // request-time still reads the principal's own permit (no role lookup, zero Router change).
    role: {
      prefix: 'USER:ROLE:',
      idsSet: 'USER:ROLE:IDS'
    },
    // External principals (passport) — manageable entity keyed by anchor (authority.md).
    passport: {
      prefix: 'USER:PASSPORT:',
      idsSet: 'USER:PASSPORT:IDS',
      saltPrefix: 'PASSPORT:SALT:',
      proofPrefix: 'PASSPORT:PROOFS:',
      otpPrefix: 'USER:PASSPORT:OTP:',
      lockPrefix: 'USER:PASSPORT:LOCK:',
      otpReqPrefix: 'USER:PASSPORT:OTPREQ:'   // per-anchor otp.request throttle counter
    },
    // §3.2 — encrypted Ed25519 signing-key doc (USER:SIGNKEY:{uid}) + retired-key SET history.
    signKeyPrefix: 'USER:SIGNKEY:'
  },

  // Passport self-service issuance (spec-passport-self-issuance.md §3) — FAIL-CLOSED.
  // default 'closed' = current behaviour (no self-service, admin-only register) → only-add-not-break.
  // Per-app override via env JSON, e.g. PASSPORT_ISSUANCE_BYAPP='{"web":"otp"}'.
  passport: {
    issuance: {
      default: process.env.PASSPORT_ISSUANCE || 'closed',          // 'closed' | 'otp' | 'pending'
      byApp: safeJson(process.env.PASSPORT_ISSUANCE_BYAPP, {}),
    },
    defaultRole: {
      default: process.env.PASSPORT_DEFAULT_ROLE || null,          // MUST be a row-isolated role ($owner)
      byApp: safeJson(process.env.PASSPORT_DEFAULT_ROLE_BYAPP, {}),
    },
    // Authority routing (spec-passport-identity-line §2.1): route a passport to a pre-configured
    // bot account's permit instead of a role. If set for an app, it takes precedence over defaultRole.
    defaultBot: {
      default: process.env.PASSPORT_DEFAULT_BOT || null,           // bot account id (permit pre-configured)
      byApp: safeJson(process.env.PASSPORT_DEFAULT_BOT_BYAPP, {}),
    },
    ownerField: process.env.PASSPORT_OWNER_FIELD || 'ownerId',     // $owner field injected on bot-routed permits
    // issuance modes: 'closed' (default) | 'otp' | 'pending' | 'device' (TOFU, no OTP — §2.2)
    otp: {
      codeLen: 6, ttlSec: 300, maxAttempts: 5, lockoutSec: 900,
      // Per-anchor request throttle (fail-closed on abuse): at most `requestMax` otp.request
      // per `requestWindowSec` window for a given anchor → blunts delivery-bombing a victim's
      // email/phone and OTP-window churn. Distinct axis from maxAttempts (which throttles *verify*).
      requestMax: Number(process.env.PASSPORT_OTP_REQUEST_MAX) || 3,
      requestWindowSec: Number(process.env.PASSPORT_OTP_REQUEST_WINDOW_SEC) || 60,
      echo: process.env.PASSPORT_OTP_ECHO === '1',                 // dev/test ONLY — returns devCode in response
      // SMS is TEMPLATE-based at the provider layer (Aliyun TemplateCode / Twilio ContentSid):
      // no free-form text. The deployer pre-creates an OTP template via gateway.sms.template.create
      // and pins its id here; the `{code,ttl}` variables fill the template. Absent → SMS channel
      // is a no-op (fail-soft, same as a down gateway). Email needs no template (free-form content).
      smsTemplateId: process.env.PASSPORT_OTP_SMS_TEMPLATE_ID || null,
    },
  },

  // Logic Rules
  defaultLanguage: process.env.DEFAULT_LANG || 'zh',
  defaultIterations: parseInt(process.env.DEFAULT_ITERATIONS) || 200000,

  // VERSION.md §3.2 — per-user Ed25519 signing keys (approval sign-off).
  signing: {
    rateLimit: parseInt(process.env.SIGN_RATE_LIMIT) || 10,        // signs per window per uid
    rateLimitWindowSec: parseInt(process.env.SIGN_RATE_WINDOW_SEC) || 60
  },

  pageSize: parseInt(process.env.PAGE_SIZE) || 12,
  description: {
    en: {
        main: [
            "user authentication and identity management",
            "user profile and permission settings",
            "login, registration and session handling"
        ],
        methods: {
            "ping": ["check service health"],
            "methods": ["list available methods"],
            "entities": ["get entity schema definitions"],
            "user.register": ["register new user account"],
            "user.login.request": ["initiate login challenge"],
            "user.login.verify": ["verify login signature"],
            "user.profile": ["get user profile details"],
            "user.account.list": ["list all users (admin)"],
            "user.account.status": ["get user account statistics"],
            "user.account.update": ["update user profile/categories (admin)"],
            "user.account.remove": ["soft delete user (admin)"],
            "user.account.restore": ["restore deleted user (admin)"],
            "user.account.check": ["check if user can be permanently deleted"],
            "user.account.destroy": ["permanently delete user (admin)"],
            "user.permit.update": ["update user permissions (admin)"],
            "user.permit.get": ["get user permissions (admin)"],
            "user.permit.batch": ["batch update user permissions (admin)"],
            "user.category.create": ["create category"],
            "user.category.update": ["update category metadata"],
            "user.category.delete": ["delete category"],
            "user.category.list": ["list categories"],
            "user.category.get": ["get category details"],
            "user.category.item.add": ["add item to category"],
            "user.category.item.get": ["get a single category item"],
            "user.category.item.update": ["update category item"],
            "user.category.item.remove": ["remove item from category"],
            "user.bot.create": ["create a passwordless bot account (admin)"],
            "user.bot.list": ["list all bot accounts (admin)"],
            "user.bot.get": ["get bot account details (admin)"],
            "user.bot.update": ["update bot account permit or desc (admin)"],
            "user.bot.delete": ["delete a bot account (admin)"],
            "user.bot.issue.token": ["issue a session token for a bot account (admin)"],
            "user.bot.suspend": ["reversibly suspend a bot: blocks refresh/issue, kills live sessions (admin)"],
            "user.bot.resume": ["resume a suspended bot to ACTIVE (admin)"],
            "user.token.refresh": ["refresh caller's own bot session token (bot only)"],
            "user.token.revoke": ["revoke all live session tokens of a uid (admin)"],
            "user.role.set": ["define/update a role (named permit template)"],
            "user.role.list": ["list roles"],
            "user.role.get": ["get a role"],
            "user.role.assign": ["materialize a role's permit onto an internal user"],
            "user.passport.register": ["onboard/update an external principal + register a device (admin)"],
            "user.passport.list": ["list external principals (admin)"],
            "user.passport.get": ["get an external principal + its devices (admin)"],
            "user.passport.disable": ["disable an external principal + revoke its sessions (admin)"],
            "user.passport.verify": ["external user authenticates with a device token; returns a restricted session"],
            "user.passport.otp.request": ["self-service: request an OTP to prove anchor ownership (public, fail-closed)"],
            "user.passport.otp.verify": ["self-service: verify OTP → issue a device token / land PENDING (public)"],
            "user.passport.device.issue": ["identity-line: device-anchor TOFU issuance (no OTP), routes to app default bot/role"],
            "user.passport.upgrade": ["identity-line: upgrade device-anchor passport → email/phone anchor, carry role/bot/meta"],
            "user.key.generate": ["generate/re-provision your Ed25519 signing keypair (self-only)"],
            "user.key.sign": ["sign a hex digest as yourself (rate-limited)"],
            "user.key.public": ["get a uid public key + retired-key history"],
            "user.key.status": ["whether a uid has an active signing key"],
            "user.key.revoke": ["admin: retire a uid signing key (forgot-password recovery)"]
        }
    },
    zh: {
        main: [
            "用户认证和身份管理",
            "用户资料和权限设置",
            "登录、注册和会话处理",
            "不处理具体的业务逻辑（如订单、会议），仅处理人"
        ],
        methods: {
            "ping": ["检查服务健康状态"],
            "methods": ["列出可用方法"],
            "entities": ["获取实体 Schema 定义"],
            "user.register": ["注册新用户账号"],
            "user.login.request": ["发起登录挑战"],
            "user.login.verify": ["验证登录签名"],
            "user.profile": ["获取用户资料详情"],
            "user.account.list": ["列出所有用户（管理员）"],
            "user.account.status": ["获取用户账号统计信息"],
            "user.account.update": ["更新用户资料/分类（管理员）"],
            "user.account.remove": ["软删除用户（管理员）"],
            "user.account.restore": ["恢复已删除用户（管理员）"],
            "user.account.check": ["检查用户是否可永久删除"],
            "user.account.destroy": ["永久删除用户（管理员）"],
            "user.permit.update": ["更新用户权限（管理员）"],
            "user.permit.get": ["获取用户权限（管理员）"],
            "user.permit.batch": ["批量更新用户权限（管理员）"],
            "user.category.create": ["创建分类"],
            "user.category.update": ["更新分类元数据"],
            "user.category.delete": ["删除分类"],
            "user.category.list": ["列出分类"],
            "user.category.get": ["获取分类详情"],
            "user.category.item.add": ["添加分类项"],
            "user.category.item.get": ["获取单个分类项"],
            "user.category.item.update": ["更新分类项"],
            "user.category.item.remove": ["移除分类项"],
            "user.bot.create": ["创建无密码 Bot 账号（管理员）"],
            "user.bot.list": ["列出所有 Bot 账号（管理员）"],
            "user.bot.get": ["获取 Bot 账号详情（管理员）"],
            "user.bot.update": ["更新 Bot 账号 permit 或描述（管理员）"],
            "user.bot.delete": ["删除 Bot 账号（管理员）"],
            "user.bot.issue.token": ["为 Bot 账号签发 session token（管理员）"],
            "user.bot.suspend": ["可逆暂停 Bot：阻断续签/发证并杀掉活跃 session（管理员）"],
            "user.bot.resume": ["恢复已暂停的 Bot 为 ACTIVE（管理员）"],
            "user.token.refresh": ["Bot 账号刷新自身 session token（仅限 bot 调用）"],
            "user.token.revoke": ["吊销某 uid 的全部有效 session token（管理员）"],
            "user.role.set": ["定义/更新角色（命名 permit 模板）"],
            "user.role.list": ["列出角色"],
            "user.role.get": ["获取角色"],
            "user.role.assign": ["把角色的 permit 物化到内部用户上"],
            "user.passport.register": ["登记/更新外部主体并注册设备（管理员）"],
            "user.passport.list": ["列出外部主体（管理员）"],
            "user.passport.get": ["获取外部主体及其设备（管理员）"],
            "user.passport.disable": ["禁用外部主体并吊销其 session（管理员）"],
            "user.passport.verify": ["外部用户用设备 token 认证，返回受限 session"],
            "user.passport.otp.request": ["自助：申请 OTP 证明 anchor 归属（public，fail-closed）"],
            "user.passport.otp.verify": ["自助：验 OTP → 发设备 token / 落 PENDING（public）"],
            "user.passport.device.issue": ["身份线：device-anchor TOFU 发证（免 OTP），路由到 app 默认 bot/role"],
            "user.passport.upgrade": ["身份线：device-anchor passport 升级到 email/手机 anchor，搬 role/bot/meta"],
            "user.key.generate": ["生成/重发自己的 Ed25519 签名密钥对（仅本人）"],
            "user.key.sign": ["以本人身份签名一个 hex digest（限速）"],
            "user.key.public": ["获取某 uid 的公钥及历史公钥"],
            "user.key.status": ["某 uid 是否有可用签名密钥"],
            "user.key.revoke": ["管理员：吊销某 uid 的签名密钥（忘记密码恢复）"]
        }
    }
  },
  idLengths: {
    user: 16
  },
  seeds: {
    categories: [
        {
            // POWER = account tier (admin/operator/normal): "which kind of user / which
            // portal can they enter". Distinct from RBAC role (user.role.* → permit).
            // (Renamed from ROLE to free "role" for RBAC — see docs/protocol/zh/authority.md.)
            key: 'POWER',
            type: 'LIST',
            scope: 'LOCAL',
            desc: 'Account power tier',
            status: 'ACTIVE',
            items: [
                {
                    id: 'normal',
                    label: { zh: '普通用户', en: 'Normal User' },
                    desc: 'Standard system user'
                },
                {
                    id: 'operator',
                    label: { zh: '运维人员', en: 'Operator' },
                    desc: 'System maintenance personnel'
                }
            ]
        }
    ]
  }
};
