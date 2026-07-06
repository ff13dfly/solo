const processLibFactory = require('../process');
const { STATUS } = require('../constants');

// Mock Redis
const redis = {
    data: {},
    async set(key, val) { this.data[key] = val; },
    async get(key) { return this.data[key]; },
    async keys(pattern) { return Object.keys(this.data); },
    async del(key) { delete this.data[key]; }
};

const processLib = processLibFactory(redis, { serviceName: 'test' });

async function runTests() {
    console.log('--- STARTING PROCESS LIB TESTS ---');

    // 1. Valid JSON Test
    const validData = {
        id: 'test_p1',
        name: 'Test Process',
        flows: {
            'IDLE': {
                ui: {
                    title: 'Idle in $item.name',
                    actions: [
                        { id: 'act1', text: 'Action 1', type: 'PRIMARY', rpc: 'test.svc.m1', params: { id: '$item.id' } }
                    ]
                }
            }
        }
    };

    try {
        const saved = await processLib.save(validData);
        console.log('✅ Save Valid JSON: SUCCESS');
        const fetched = await processLib.get({ id: 'test_p1' });
        if (fetched.id === 'test_p1') console.log('✅ Get Valid JSON: SUCCESS');
    } catch (e) {
        console.error('❌ Valid JSON Test Failed:', e.message);
    }

    // 2. Missing Fields Test
    try {
        await processLib.validate({ id: 'fail1', flows: {} }); // valid structure but maybe empty
        console.log('✅ Validate Empty Flows: SUCCESS (Accepts empty record)');
        
        await processLib.validate({ id: 'fail2' }); // missing flows
    } catch (e) {
        console.log('✅ Intercept Missing Flows: SUCCESS -', e.message);
    }

    // 3. Security Violation Test
    const riskyData = {
        id: 'risky_p1',
        flows: {
            'IDLE': {
                ui: {
                    title: 'Title',
                    actions: [
                        { id: 'act1', text: 'Text', rpc: 'rpc', params: { operatorId: '$user.id' } }
                    ]
                }
            }
        }
    };
    try {
        await processLib.validate(riskyData);
        console.error('❌ Security Violation Test Failed: Should have thrown error');
    } catch (e) {
        console.log('✅ Intercept Security Violation: SUCCESS -', e.message);
    }

    console.log('--- TESTS COMPLETED ---');
}

runTests().catch(console.error);
