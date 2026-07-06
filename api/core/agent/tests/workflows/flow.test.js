
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const QwenProvider = require('../../providers/qwen');
const CapabilityManager = require('../../CapabilityManager');

// Mock CapabilityManager methods to simulate Redis state
CapabilityManager.getServiceDescriptions = (lang) => {
    if (lang === 'zh') {
        return `
- crm: 客户关系管理，管理外部公司和联系人，不用于内部员工
- agenda: 日程管理，会议组织，不用于内部人事会议
- finance: 财务管理，资金往来
`;
    }
    return `
- crm: Customer relationship management, external entities only
- agenda: Agenda and schedule management, NOT for internal HR
- finance: Financial management
`;
};

CapabilityManager.getMethodsForService = (service, lang) => {
    if (service === 'crm') return '- crm.company.create: 创建新客户\n- crm.company.update: 更新客户';
    if (service === 'agenda') return '- agenda.create: 创建日程\n- agenda.list: 列出日程';
    return '';
};

async function runTest() {
    console.log('--- Verifying 2-Step Logic (Mocked) ---');
    
    const config = {
        qwenApiKey: process.env.DASHSCOPE_API_KEY,
        language: 'zh'
    };
    
    // Test Qwen
    const qwen = new QwenProvider(config);
    
    const inputs = [
        "公司新来了个后端工程师", // Should be blocked (agent)
        "明天下午要去拜访一家新客户", // Should be crm
        "帮我安排一个内部面试会议" // Should be blocked or chat (agenda negative constraint?)
    ];

    for (const input of inputs) {
        console.log(`\nInput: "${input}"`);
        const result = await qwen.identifyPurpose({ text: input, capabilities: [] }); // capabilities arg ignored by new logic
        console.log(`Result: ${result}`);
    }
}

runTest();
