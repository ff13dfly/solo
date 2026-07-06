require('dotenv').config();
const QwenProvider = require('../../providers/qwen');

// 模拟 config
const config = {
    qwenApiKey: process.env.QWEN_API_KEY,
    language: 'zh'
};

// 构造 Phase 1 的测试数据
const testData = {
    text: "新来一个员工，陈大力，手机13301232233，设计部设计师",
    phase: 1,
    context: {
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
    }
};

async function testPhase1() {
    console.log('=== Phase 1 测试 ===\n');
    console.log('用户输入:', testData.text);
    console.log('\n可用服务:');
    testData.context.services.forEach(s => console.log('  ' + s));
    console.log('\n工作流分类:');
    testData.context.categories.forEach(c => console.log('  ' + c));
    console.log('\n正在调用阿里千问...\n');

    const provider = new QwenProvider(config);
    
    try {
        const result = await provider.identifyPurposeWithContext({
            text: testData.text,
            phase: testData.phase,
            context: testData.context
        });
        
        console.log('=== 千问返回结果 ===');
        console.log(JSON.stringify(result, null, 2));
        
        console.log('\n=== 解析结果 ===');
        if (result.services && result.services.length > 0) {
            console.log('\n选中的服务:');
            result.services.forEach(s => {
                console.log(`  - ${s.name}: ${s.score}`);
            });
        }
        
        if (result.categories && result.categories.length > 0) {
            console.log('\n选中的分类:');
            result.categories.forEach(c => {
                console.log(`  - ${c.key}: ${c.score}`);
            });
        }
        
    } catch (error) {
        console.error('错误:', error.message);
        console.error(error.stack);
    }
}

testPhase1();
