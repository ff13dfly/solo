/**
 * SOLO E2E — hermetic unit config for helpers under lib/ (e.g. teardown logic).
 * NO globalSetup → these run WITHOUT booting the stack or Redis. Fast, pure.
 */
module.exports = {
    rootDir: __dirname,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/lib/**/*.test.js'],
    testTimeout: 10_000,
};
