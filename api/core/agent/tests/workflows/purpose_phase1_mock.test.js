/**
 * Phase 1 模拟测试 - 展示预期的千问返回
 */

console.log('=== Phase 1 测试 (模拟千问返回) ===\n');

const userInput = "新来一个员工，陈大力，手机13301232233，设计部设计师";

const context = {
    services: [
        "- company: 企业组织架构管理; 员工档案管理",
        "- user: 系统账号管理; 登录认证",
        "- crm: 客户关系管理; 销售线索跟踪",
        "- asset: 资产管理; 办公空间分配",
        "- notification: 消息通知; 短信邮件发送",
        "- finance: 财务管理; 账目记录",
        "- agenda: 日程管理; 任务跟踪",
        "- note: 笔记管理; 知识库"
    ],
    categories: [
        "- Onboarding: 员工入职 (员工入职相关流程)",
        "- Offboarding: 员工离职 (员工离职相关流程)",
        "- Approval: 审批流程 (各类审批工作流)"
    ]
};

console.log('用户输入:', userInput);
console.log('\n发送给千问的 Prompt:');
console.log('─'.repeat(60));

const prompt = `
用户输入: "${userInput}"

=== 可用服务 (Services) ===
${context.services.join('\n')}

=== 工作流分类 (Workflow Categories) ===
${context.categories.join('\n')}

请执行:
1. 对每个服务和分类进行相关性打分 (0.0-1.0)
2. 返回 Top 2 服务 (按 score 降序)
3. 返回 Top 2 工作流分类 (按 score 降序)

返回格式 (JSON):
{
  "services": [{ "name": "服务名", "score": 0.95 }, ...],
  "categories": [{ "key": "分类key", "score": 0.90 }, ...]
}

仅返回 JSON，不要其他内容。
`;

console.log(prompt);
console.log('─'.repeat(60));

// 模拟千问的预期返回
const mockQwenResponse = {
    services: [
        { name: "company", score: 0.95 },
        { name: "user", score: 0.75 }
    ],
    categories: [
        { key: "Onboarding", score: 0.98 },
        { key: "Approval", score: 0.35 }
    ]
};

console.log('\n=== 预期的千问返回 (JSON) ===');
console.log(JSON.stringify(mockQwenResponse, null, 2));

console.log('\n=== 解析结果 ===');
console.log('\n✅ 选中的服务 (Top 2):');
mockQwenResponse.services.forEach((s, idx) => {
    console.log(`  ${idx + 1}. ${s.name} (置信度: ${(s.score * 100).toFixed(0)}%)`);
});

console.log('\n✅ 选中的工作流分类 (Top 2):');
mockQwenResponse.categories.forEach((c, idx) => {
    console.log(`  ${idx + 1}. ${c.key} (置信度: ${(c.score * 100).toFixed(0)}%)`);
});

console.log('\n=== Phase 2 将使用的数据 ===');
console.log('从缓存中提取以下服务的方法:');
mockQwenResponse.services.forEach(s => console.log(`  - ${s.name} 服务的所有方法`));

console.log('\n从缓存中提取以下分类的工作流:');
mockQwenResponse.categories.forEach(c => console.log(`  - ${c.key} 分类的所有工作流`));

console.log('\n✅ Phase 1 完成，准备进入 Phase 2');
