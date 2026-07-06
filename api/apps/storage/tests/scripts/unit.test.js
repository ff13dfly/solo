const fs = require('fs');
const path = require('path');
const { setup, teardown } = require('../bootstrap');
const createLogic = require('../../logic');

/**
 * Universal Unit Test Runner
 * Reads unit.yaml and executes logic methods directly.
 */

async function runTests() {
    console.log('🚀 Starting Unit Tests for Storage...');
    
    const { redisClient, config } = await setup();
    const Methods = createLogic(redisClient, { config });
    const context = {};

    const casesPath = path.resolve(__dirname, '../cases/unit.yaml');
    if (!fs.existsSync(casesPath)) {
        console.error('❌ Error: unit.yaml not found at', casesPath);
        process.exit(1);
    }

    const content = fs.readFileSync(casesPath, 'utf8');
    // Basic YAML-like parser for the specific format used in Solo
    const rawCases = content.split('\n- name: ');
    rawCases.shift(); // remove empty start

    let passed = 0;
    let failed = 0;

    for (const raw of rawCases) {
        const lines = raw.split('\n');
        const name = lines[0].trim();
        const testCase = { name };
        
        let currentKey = null;
        let indent = 0;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim() || line.startsWith('#')) continue;
            
            const match = line.match(/^(\s*)([^:]+):\s*(.*)$/);
            if (match) {
                const [_, ws, key, value] = match;
                if (ws.length === 2) {
                    currentKey = key.trim();
                    testCase[currentKey] = {};
                } else if (ws.length === 4 && currentKey) {
                    let val = value.trim();
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    testCase[currentKey][key.trim()] = val;
                }
            }
        }

        console.log(`\nTEST: ${testCase.name}`);
        
        try {
            // 1. Resolve Params
            const params = { ...testCase.params };
            for (const key in params) {
                if (typeof params[key] === 'string' && params[key].startsWith('${last.')) {
                    const field = params[key].slice(7, -1);
                    params[key] = context.last[field];
                }
            }

            // 2. Execute
            const [service, entity, method] = testCase.name.split('.');
            if (!Methods[entity] || !Methods[entity][method]) {
                throw new Error(`Method ${testCase.name} not found in logic`);
            }

            const result = await Methods[entity][method](params);
            context.last = result;

            // 3. Verify
            const expectations = testCase.expect || {};
            for (const key in expectations) {
                const expected = expectations[key];
                const actual = result[key];

                if (expected.startsWith('length:')) {
                    const len = parseInt(expected.split(':')[1]);
                    if (actual.length !== len) throw new Error(`${key} length ${actual.length} != ${len}`);
                } else if (expected.startsWith('contains:')) {
                    const substr = expected.split(':')[1];
                    if (!String(actual).includes(substr)) throw new Error(`${key} "${actual}" does not contain "${substr}"`);
                } else if (String(actual) !== String(expected)) {
                    throw new Error(`${key} "${actual}" != "${expected}"`);
                }
            }

            console.log('✅ Result:', JSON.stringify(result).substring(0, 100) + '...');
            passed++;
        } catch (err) {
            console.error('❌ Failed:', err.message);
            failed++;
        }
    }

    console.log(`\n========================================`);
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    console.log(`========================================`);

    await teardown();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
