/**
 * Test agent.focus with Qwen
 * Usage: node test_focus.js
 */

const https = require('https');

// Test configuration
const AGENT_PORT = 8730;
const AGENT_HOST = 'localhost';

// Test cases
const testCases = [
    {
        name: '1. 提取会议室参数',
        params: {
            workflow_id: 'meeting_setup_v1',
            workflow_name: '安排项目会议',
            workflow_desc: '预订会议室并发送通知',
            current_params: { duration: 60, platform: 'Zoom' },
            missing_fields: ['roomId', 'startTime'],
            synonyms: {
                roomId: ['会议室', '小红屋', '三楼大厅', '一楼大厅'],
                startTime: ['开始时间', '几点', '什么时候']
            },
            user_input: '用三楼的大厅，明天下午三点开始',
            model: 'qwen-turbo'
        },
        expect: {
            hasRoomId: true,
            hasStartTime: true
        }
    },
    {
        name: '2. 部分参数提取',
        params: {
            workflow_id: 'meeting_setup_v1',
            workflow_name: '安排项目会议',
            workflow_desc: '预订会议室并发送通知',
            current_params: { duration: 60 },
            missing_fields: ['roomId', 'startTime', 'platform'],
            synonyms: {
                roomId: ['会议室', '小红屋', '三楼大厅'],
                platform: ['平台', 'Zoom', '腾讯会议', 'Teams']
            },
            user_input: '用三楼大厅',
            model: 'qwen-turbo'
        },
        expect: {
            hasRoomId: true,
            hasHint: true
        }
    },
    {
        name: '3. 取消操作',
        params: {
            workflow_id: 'meeting_setup_v1',
            workflow_name: '安排项目会议',
            current_params: {},
            missing_fields: ['roomId', 'startTime'],
            user_input: '算了，不要了',
            model: 'qwen-turbo'
        },
        expect: {
            action: 'exit_focus'
        }
    },
    {
        name: '4. 全部参数完成',
        params: {
            workflow_id: 'meeting_setup_v1',
            workflow_name: '安排项目会议',
            current_params: { roomId: 'floor3_hall', startTime: '2026-01-10T15:00:00' },
            missing_fields: [],
            user_input: '对，就这样',
            model: 'qwen-turbo'
        },
        expect: {
            hintContainsConfirm: true
        }
    }
];

// HTTP request helper
function callAgent(method, params) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: Date.now()
        });

        const options = {
            hostname: AGENT_HOST,
            port: AGENT_PORT,
            path: '/jsonrpc',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = require('http').request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    reject(new Error('Invalid JSON response: ' + data));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// Run tests
async function runTests() {
    console.log('===== agent.focus Test Suite =====\n');
    
    let passed = 0;
    let failed = 0;

    for (const tc of testCases) {
        console.log(`\n🧪 ${tc.name}`);
        console.log(`   Input: "${tc.params.user_input}"`);
        
        try {
            const response = await callAgent('agent.focus', tc.params);
            
            if (response.error) {
                console.log(`   ❌ Error: ${response.error.message}`);
                failed++;
                continue;
            }

            const result = response.result;
            console.log(`   📤 Response:`);
            console.log(`      extracted_params: ${JSON.stringify(result.extracted_params)}`);
            console.log(`      confidence: ${JSON.stringify(result.confidence)}`);
            console.log(`      hint: "${result.hint}"`);
            console.log(`      action: ${result.action}`);

            // Validate expectations
            let testPassed = true;
            
            if (tc.expect.hasRoomId && !result.extracted_params.roomId) {
                console.log(`   ⚠️  Expected roomId but not found`);
                testPassed = false;
            }
            
            if (tc.expect.hasStartTime && !result.extracted_params.startTime) {
                console.log(`   ⚠️  Expected startTime but not found`);
                testPassed = false;
            }
            
            if (tc.expect.hasHint && !result.hint) {
                console.log(`   ⚠️  Expected hint but not found`);
                testPassed = false;
            }
            
            if (tc.expect.action && result.action !== tc.expect.action) {
                console.log(`   ⚠️  Expected action="${tc.expect.action}" but got "${result.action}"`);
                testPassed = false;
            }
            
            if (tc.expect.hintContainsConfirm && result.hint && 
                !result.hint.includes('确认') && !result.hint.includes('执行') && !result.hint.includes('confirm')) {
                console.log(`   ⚠️  Expected hint to contain confirmation prompt`);
                testPassed = false;
            }

            if (testPassed) {
                console.log(`   ✅ PASSED`);
                passed++;
            } else {
                console.log(`   ❌ FAILED`);
                failed++;
            }

        } catch (error) {
            console.log(`   ❌ Error: ${error.message}`);
            failed++;
        }
    }

    console.log(`\n===== Results =====`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`Total: ${testCases.length}`);
}

runTests();
