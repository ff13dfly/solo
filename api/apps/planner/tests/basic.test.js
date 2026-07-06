/**
 * Basic Compliance Test for Sample Service
 */

const assert = require('assert');
const config = require('../config');

console.log('Running basic compliance tests...');

// Test 1: Config structure
try {
    assert.ok(config.serviceName, 'serviceName should be defined');
    assert.ok(config.port, 'port should be defined');
    console.log('✓ Config check passed');
} catch (e) {
    console.error('✗ Config check failed:', e.message);
    process.exit(1);
}

// Test 2: Introspection structure
try {
    const methods = require('../handlers/introspection');
    assert.ok(Array.isArray(methods), 'Introspection should export an array');
    assert.ok(methods.length > 0, 'Introspection should not be empty');
    console.log('✓ Introspection check passed');
} catch (e) {
    console.error('✗ Introspection check failed:', e.message);
    process.exit(1);
}

console.log('\nAll basic tests passed! (2/2)');
process.exit(0);
