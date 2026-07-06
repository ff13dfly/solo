require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
  serviceName: process.env.SERVICE_NAME || 'administrator',
  category: 'system',
  version: pkg.version || '0.1.0',
  port: portFor('administrator', 8680),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',

  routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
  routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',
  defaultIterations: 200000,
  challengeTtl: 60000, // 60 seconds
  sessionTtl: 1800, // 30 minutes (sliding)
  debug: process.env.DEBUG !== 'false',

  // AI Semantic Descriptions (for intent detection / portal capability views)
  description: {
    en: {
      main: [
        'system administration backplane: single-admin account, sessions, settings',
        'runtime automation control (pause/resume the nexus + orchestrator auto loops)',
        'error-log aggregation across the fleet (ERROR:QUEUE drain)',
      ],
      methods: {
        'admin.login.request': ['begin the admin challenge-response login'],
        'admin.login.verify': ['verify the login challenge and mint a session'],
        'setting.automation.status': ['aggregate auto/manual state across services'],
        'setting.automation.pause': ['pause ALL automation loops (degrade to manual)'],
        'setting.automation.resume': ['resume ALL automation loops'],
        'setting.display.list': ['list all entity display manifests (operator boot)'],
        'setting.display.get': ['get one entity display manifest'],
        'setting.display.set': ['upsert an entity display manifest (structural-validated)'],
        'setting.display.delete': ['delete an entity display manifest (reset to base)'],
      },
    },
    zh: {
      main: [
        '系统管理后台：单管理员账号、会话、系统设置',
        '运行时自动化总控（暂停/恢复 nexus + orchestrator 自动循环）',
        '全队错误日志汇聚（ERROR:QUEUE）',
      ],
      methods: {
        'admin.login.request': ['发起管理员挑战-响应登录'],
        'admin.login.verify': ['校验登录挑战并签发会话'],
        'setting.automation.status': ['聚合各服务自动/手动状态'],
        'setting.automation.pause': ['一键暂停全部自动化循环（降级为人工）'],
        'setting.automation.resume': ['恢复全部自动化循环'],
        'setting.display.list': ['列出全部实体显示清单（operator 启动拉取）'],
        'setting.display.get': ['获取单个实体显示清单'],
        'setting.display.set': ['写入实体显示清单（结构校验）'],
        'setting.display.delete': ['删除实体显示清单（重置回静态基线）'],
      },
    },
  },

  // System-level automation control (the auto↔manual seam). administrator shares the
  // one Redis instance, so it flips each service's runtime pause flag DIRECTLY — no
  // RPC fan-out / relay needed. Keys must match each service's config.redis.controlPausedKey.
  automationServices: [
    { service: 'nexus',        pausedKey: 'NEXUS:CONTROL:PAUSED' },
    { service: 'orchestrator', pausedKey: 'ORCHESTRATOR:CONTROL:PAUSED' },
  ],

  // Redis 存储配置
  redis: {
    // 管理员用户存储 key 前缀
    // 完整 key 格式: administrator:user:{username}
    userKeyPrefix: 'administrator:user:',
    // Session key prefix
    sessionKeyPrefix: 'session:',
    // Error queue prefix
    errorQueuePrefix: 'ERROR:QUEUE:',
    // Active services list key
    activeServicesKey: 'active_services'
  }
};
