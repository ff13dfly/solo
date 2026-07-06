/**
 * system.manifest
 *
 * 面向外部 AI 的系统入口文档。返回：
 *   - 鉴权说明
 *   - 服务目录（在线状态 + 职责描述 + 核心方法）
 *   - API 约定（分页、错误码、ai:true 含义）
 *   - 样例工作流（可直接执行的调用链）
 *
 * public: true — 无需 token 即可获取，方便外部 AI 自主引导。
 */

// 从服务注册的 description.en.main 中取第一条作为一行摘要
// 各服务通过 methods 响应传入 description，Router 握手时写入 SERVICES[name].description
function extractSummary(svcDescription) {
    try {
        const main = svcDescription?.en?.main;
        if (Array.isArray(main) && main.length > 0) return main[0];
        if (typeof main === 'string' && main) return main;
    } catch {}
    return '';
}

// 样例工作流（展示跨服务链路调用）
const EXAMPLES = [
    {
        goal: '用 AI 解析图片内容并翻译为英文',
        steps: [
            {
                method: 'agent.image.parse',
                params: { imageUrl: '<图片URL>', prompt: '提取文字内容' },
                returns: 'text',
                note: 'AI 识别图片中的文字',
            },
            {
                method: 'agent.text.translate',
                params: { text: '<上一步 result.text>', targetLang: 'en' },
                returns: 'translatedText',
                note: '将识别结果翻译成英文',
            },
        ],
    },
    {
        goal: '触发工作流并在完成后发送通知',
        steps: [
            {
                method: 'orchestrator.workflow.execute',
                params: { templateId: '<模板ID>', input: { key: 'value' } },
                returns: 'id, status',
                note: '启动工作流执行实例',
            },
            {
                method: 'notification.message.send',
                params: { uid: '<接收人UID>', channel: 'inbox', content: '工作流 <id> 已完成' },
                returns: 'id, delivered',
                note: '向目标用户发送站内通知',
            },
        ],
    },
    {
        goal: '上传文件并将 URL 持久化到日程',
        steps: [
            {
                method: 'storage.file.upload',
                params: { name: '<文件名>', mimeType: 'application/pdf', data: '<base64>' },
                returns: 'id, url',
                note: '将文件存入 CAS，返回 SHA-256 寻址 URL',
            },
            {
                method: 'planner.task.create',
                params: { title: '<任务标题>', attachments: ['<上一步 result.url>'] },
                returns: 'id, status',
                note: '创建待办并附加文件链接',
            },
        ],
    },
    {
        goal: '订阅 webhook 事件并让 Sentinel 自动响应',
        steps: [
            {
                method: 'ingress.source.create',
                params: { name: '<来源名称>', dedupTtlSec: 3600 },
                returns: 'id, apiKey',
                note: '注册入站数据源，获取 API Key',
            },
            {
                method: 'nexus.sentinel.create',
                params: { name: '<Sentinel名>', role: '<角色>', eventPattern: 'EVENT:WEBHOOK:*' },
                returns: 'id',
                note: '注册 Sentinel，自动监听该 webhook 事件',
            },
        ],
    },
];

module.exports = function createManifestHandler(SERVICES) {
    return function manifest(params, id, res) {

        // 从活跃服务中提取目录（只保留 online 的服务）
        const catalog = Object.entries(SERVICES)
            .filter(([, svc]) => svc.available !== false)
            .map(([name, svc]) => {
                const aiMethods = (svc.methods || [])
                    .filter(m => m.ai === true)
                    .slice(0, 8)  // 只列前8个核心 AI 方法，不做信息轰炸
                    .map(m => ({
                        name: m.name,
                        description: m.description,
                        params: (m.params || []).map(p => p.name),
                        returns: m.returns || [],
                    }));

                return {
                    name,
                    description: extractSummary(svc.description),
                    status: 'online',
                    aiMethodCount: (svc.methods || []).filter(m => m.ai).length,
                    keyMethods: aiMethods,
                };
            })
            .sort((a, b) => b.aiMethodCount - a.aiMethodCount);

        const result = {
            system: 'Solo·AI',
            description: 'AI-Native 微服务底座，提供网关、工作流编排、通知投递、AI 能力路由、文件存储、事件总线。所有接口统一 JSON-RPC 2.0 协议。',
            endpoint: '',
            protocol: 'JSON-RPC 2.0',

            auth: {
                type: 'Bearer Token',
                steps: [
                    { step: 1, method: 'user.login.request', params: { name: '<username>' }, note: '获取 challenge 和 salt' },
                    { step: 2, note: 'hash = SHA256(password + salt)；response = SHA256(challenge + hash)' },
                    { step: 3, method: 'user.login.verify', params: { name: '<username>', challenge: '<challenge>', response: '<response>', deviceId: '<any>' }, note: '获取 token' },
                    { step: 4, note: '后续请求 Header: Authorization: Bearer <token>' },
                ],
                publicMethods: '部分方法标记 public:true，无需 token 即可调用',
            },

            conventions: {
                pagination:  'list 类方法接受 { page, pageSize }，返回 { items: [...], total: number }',
                errors:      '-32001 鉴权失败 | -32002 资源不存在 | -32003 业务规则冲突 | -32602 参数错误 | -32603 内部错误',
                aiMethods:   'ai:true 的方法经过 AI 调用优化，参数和返回值有明确类型定义',
                returns:     'returns 字段列出该方法的顶层返回字段名，用于链路拼接时的字段引用',
                discovery:   '调用 system.capability.list 获取完整的 ai:true 方法列表（含参数和 returns）',
            },

            services: catalog,
            examples: EXAMPLES,
        };

        return res.json({ jsonrpc: '2.0', result, id });
    };
};
