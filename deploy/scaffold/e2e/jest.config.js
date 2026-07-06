module.exports = {
    rootDir: __dirname,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/suites/**/*.e2e.test.js'],
    globalSetup: '<rootDir>/harness/setup.js',
    globalTeardown: '<rootDir>/harness/teardown.js',
    testTimeout: 60_000,
    maxWorkers: 1,
    forceExit: true,
};
