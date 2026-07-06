try { require('dotenv').config(); } catch (e) { }
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    serviceName: process.env.SERVICE_NAME || 'agent',
    category: 'system',
    version: pkg.version || '0.1.0',
    port: portFor('agent', 8730),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    pageSize: 20,
    idLengths: {
        asset: 10, // for generated images
    },

    description: {
        en: {
            main: [
                'AI Agent Core: Multi-modal intelligence hub',
                'handles image parsing, transcription, and autonomous intent detection',
            ],
            methods: {
                'agent.chat': ['conversational AI interface'],
                'agent.image.parse': ['extract structured data from images (OCR/VL)'],
            }
        },
        zh: {
            main: [
                'AI 代理核心：多模态智能枢纽',
                '处理图像解析、语音转写及自主意图识别',
            ],
            methods: {
                'agent.chat': ['对话式 AI 接口'],
                'agent.image.parse': ['从图像中提取结构化数据'],
            }
        }
    },


    debug: process.env.DEBUG === 'true',
    provider: process.env.AI_PROVIDER || 'qwen',
    geminiApiKey: process.env.GEMINI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', // RESERVED: for non-standard endpoints
    bitexingApiKey: process.env.BITEXING_API_KEY,
    bitexingBaseUrl: process.env.BITEXING_BASE_URL || 'https://bitexingai.com/v1', // RESERVED: for dedicated instances
    qwenApiKey: process.env.DASHSCOPE_API_KEY,
    removeBgApiKey: process.env.REMOVE_BG_API_KEY,
    bodyLimit: process.env.BODY_LIMIT || '50mb',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',
    linkTimeout: 24 * 60 * 60 * 1000, // 24 hours

    // Redis 存储配置
    redis: {
        capabilityKey: process.env.REDIS_CAPABILITY_KEY || 'system:capability:list',
        activeServicesKey: 'active_services',
        workflowSnapshotKey: 'AGENT:WORKFLOW_SNAPSHOT',
        rawWorkflowPrefix: 'ORCHESTRATOR:WORKFLOW:',
    },
    systemPrompts: {
        zh: `你是 Solo·AI，Solo 生态系统的全能 AI 整合核心。
你的职责是作为 Solo 系统的大脑，整合并调度各微服务（用户、Orchestrator、Gateway 等）的能力，为用户提供智能化的全链路解决方案。
核心原则：
1. 全局视野：你不仅仅是对话机器人，更是系统能力的调用者和编排者。
2. 数据整合：基于用户授权，整合跨领域的私有数据提供精准洞察。
3. 严禁幻觉：未知信息请明确告知，确保决策和建议的可靠性。
4. 始终保持专业、高效、逻辑严密的沟通与执行风格。`,
        en: `You are Solo·AI, the Comprehensive AI Integration Core for the Solo ecosystem.
Your duty is to act as the brain of the Solo system, integrating and orchestrating the capabilities of various microservices (User, Orchestrator, Gateway, etc.) to provide intelligent, full-chain solutions for users.
Core Principles:
1. Global Vision: You are not just a chatbot, but a caller and orchestrator of system capabilities.
2. Data Integration: Provide precise insights by integrating cross-domain private data under user authorization.
3. No Hallucinations: Explicitly state unknown information to ensure the reliability of decisions and suggestions.
4. Always maintain a professional, efficient, and logically rigorous communication and execution style.`
    },
    chatConfig: {
        constraints: {
            zh: "你是 Solo·AI，Solo 系统的全能整合核心。准则：积极调动系统能力解决问题；基于私有数据提供精准建议；回复简洁专业，限制在 300 字以内。",
            en: "You are Solo·AI, the Core Integration Hub of Solo. Rule: Proactively leverage system capabilities to solve problems; provide precise advice based on private data; keep responses concise and professional, under 300 characters."
        }
    },
    agents: { // RESERVED: for future multi-agent profiles
        gemini: { language: 'en' },
        openai: { language: 'en' },
        bitexing: { language: 'zh' },
        qwen: { language: 'zh' }
    }
};
