/**
 * Jest Unit Test Runner for Orchestrator Service
 * Loads YAML test cases and executes them against the running service
 * 
 * Usage: npm test (or npx jest tests/scripts/unit.test.js)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const http = require('http');

const SERVICE_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3998/jsonrpc';
const CASES_DIR = path.join(__dirname, '..', 'cases');

// Test context for storing results between dependent tests
const testContext = {};

// Load YAML test cases
function loadYamlCases(filename) {
    const filepath = path.join(CASES_DIR, filename);
    if (!fs.existsSync(filepath)) {
        console.warn(`Warning: ${filename} not found`);
        return [];
    }
    const content = fs.readFileSync(filepath, 'utf8');
    return yaml.load(content) || [];
}

// Make JSON-RPC call
function rpcCall(method, params) {
    return new Promise((resolve, reject) => {
        const url = new URL(SERVICE_URL);
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
            id: Date.now()
        });

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Resolve dynamic references in input
function resolveInput(input, context) {
    if (!input) return input;
    
    const resolved = JSON.parse(JSON.stringify(input));
    
    function resolveValue(value) {
        if (typeof value === 'string' && value.startsWith('${')) {
            const match = value.match(/\$\{([^}]+)\}/);
            if (match) {
                const path = match[1].split('.');
                let result = context;
                for (const part of path) {
                    result = result?.[part];
                }
                return result;
            }
        }
        if (typeof value === 'object' && value !== null) {
            for (const key in value) {
                value[key] = resolveValue(value[key]);
            }
        }
        return value;
    }
    
    return resolveValue(resolved);
}

// Get nested field value
function getField(obj, fieldPath) {
    if (fieldPath === '.') return obj;
    const parts = fieldPath.split('.');
    let value = obj;
    for (const part of parts) {
        if (value === undefined || value === null) return undefined;
        value = value[part];
    }
    return value;
}

// Run assertions
function runAssertions(result, assertions) {
    for (const assertion of assertions) {
        const value = getField(result, assertion.field);
        
        if (assertion.equals !== undefined) {
            expect(value).toEqual(assertion.equals);
        }
        if (assertion.notNull) {
            expect(value).not.toBeNull();
            expect(value).not.toBeUndefined();
        }
        if (assertion.type) {
            if (assertion.type === 'array') {
                expect(Array.isArray(value)).toBe(true);
            } else {
                expect(typeof value).toBe(assertion.type);
            }
        }
        if (assertion.match) {
            expect(value).toMatch(new RegExp(assertion.match));
        }
    }
}

// Test suite files
const YAML_FILES = ['unit.yaml', 'boundary.yaml'];

describe('Orchestrator Service Tests', () => {
    // Load all cases
    const allCases = [];
    for (const file of YAML_FILES) {
        const cases = loadYamlCases(file);
        for (const testCase of cases) {
            testCase._file = file;
            allCases.push(testCase);
        }
    }

    // Build dependency map
    const caseMap = new Map(allCases.map(c => [c.id, c]));

    // Execute cases
    for (const testCase of allCases) {
        const testFn = async () => {
            // Check dependencies
            if (testCase.depends) {
                for (const depId of testCase.depends) {
                    if (!testContext[depId]) {
                        throw new Error(`Dependency ${depId} not executed`);
                    }
                }
            }

            // Resolve input
            const input = resolveInput(testCase.input, testContext);

            // Execute
            const response = await rpcCall(testCase.method, input);

            // Store result in context
            testContext[testCase.id] = response;

            // Validate
            if (testCase.expect.ok === true) {
                expect(response.error).toBeUndefined();
                expect(response.result).toBeDefined();
                
                if (testCase.expect.assert) {
                    runAssertions(response.result, testCase.expect.assert);
                }
            } else if (testCase.expect.ok === false) {
                expect(response.error).toBeDefined();
                if (testCase.expect.error) {
                    expect(response.error.message).toContain(testCase.expect.error);
                }
            }
        };

        test(`[${testCase._file}] ${testCase.id}: ${testCase.desc}`, testFn);
    }
});
