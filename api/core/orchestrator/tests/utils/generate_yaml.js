/**
 * YAML Test Case Generator for Orchestrator Service
 * Generates unit.yaml and boundary.yaml from templates
 * 
 * Usage: node api/orchestrator/tests/utils/generate_yaml.js
 */

const fs = require('fs');
const path = require('path');

const CASES_DIR = path.join(__dirname, '..', 'cases');

// Ensure cases directory exists
if (!fs.existsSync(CASES_DIR)) {
    fs.mkdirSync(CASES_DIR, { recursive: true });
}

// Generate test IDs
function genId(prefix, num) {
    return `${prefix}-${String(num).padStart(2, '0')}`;
}

// Unit test templates
const unitTests = [
    {
        id: genId('ORCH-CREATE', 1),
        method: 'orchestrator.workflow.create',
        desc: 'Create valid workflow',
        input: {
            id: 'gen_test_1',
            category: 'Generated',
            name: 'Generated Workflow',
            desc: 'Auto-generated test workflow',
            steps: [
                { id: 's1', service: 'sample', method: 'sample.ping', params: {} }
            ]
        },
        expect: { ok: true, assert: [{ field: 'status', equals: 'ACTIVE' }] }
    },
    {
        id: genId('ORCH-GET', 1),
        method: 'orchestrator.workflow.get',
        desc: 'Get existing workflow',
        depends: [genId('ORCH-CREATE', 1)],
        input: { id: 'gen_test_1' },
        expect: { ok: true, assert: [{ field: 'id', equals: 'gen_test_1' }] }
    },
    {
        id: genId('ORCH-LIST', 1),
        method: 'orchestrator.workflow.list',
        desc: 'List all workflows',
        input: {},
        expect: { ok: true, assert: [{ field: 'items', type: 'array' }] }
    },
    {
        id: genId('ORCH-DELETE', 1),
        method: 'orchestrator.workflow.delete',
        desc: 'Soft delete workflow',
        depends: [genId('ORCH-CREATE', 1)],
        input: { id: 'gen_test_1' },
        expect: { ok: true, assert: [{ field: 'success', equals: true }] }
    },
    {
        id: genId('ORCH-RESTORE', 1),
        method: 'orchestrator.workflow.restore',
        desc: 'Restore deleted workflow',
        depends: [genId('ORCH-DELETE', 1)],
        input: { id: 'gen_test_1' },
        expect: { ok: true, assert: [{ field: 'success', equals: true }] }
    }
];

// Boundary test templates
const boundaryTests = [
    {
        id: genId('BOUND-CREATE', 1),
        method: 'orchestrator.workflow.create',
        desc: 'Missing id',
        input: { category: 'Test', name: 'Test', desc: 'Test', steps: [] },
        expect: { ok: false, error: 'MISSING_PARAM: id required' }
    },
    {
        id: genId('BOUND-GET', 1),
        method: 'orchestrator.workflow.get',
        desc: 'Missing id',
        input: {},
        expect: { ok: false, error: 'MISSING_PARAM: id required' }
    },
    {
        id: genId('BOUND-RUN', 1),
        method: 'orchestrator.run',
        desc: 'Missing workflowId',
        input: {},
        expect: { ok: false, error: 'MISSING_PARAM: workflowId required' }
    }
];

// Convert to YAML format
function toYaml(tests) {
    const yaml = require('js-yaml');
    return yaml.dump(tests, { lineWidth: -1, noRefs: true });
}

// Write files
try {
    const yaml = require('js-yaml');
    
    fs.writeFileSync(
        path.join(CASES_DIR, 'generated_unit.yaml'),
        toYaml(unitTests)
    );
    console.log('Generated: cases/generated_unit.yaml');
    
    fs.writeFileSync(
        path.join(CASES_DIR, 'generated_boundary.yaml'),
        toYaml(boundaryTests)
    );
    console.log('Generated: cases/generated_boundary.yaml');
    
    console.log('\n✅ Test cases generated successfully');
} catch (e) {
    console.error('Error generating YAML:', e.message);
    console.log('Run `npm install js-yaml` first if js-yaml is missing');
}
