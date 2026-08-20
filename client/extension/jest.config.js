/**
 * Standalone gate for the extension kit.
 *
 * @why NOT folded into api/jest.ci.config.js: the kit is ESM (MV3 service workers
 *      run `"type": "module"`), and ESM under jest needs
 *      `NODE_OPTIONS=--experimental-vm-modules`. Turning that on for the main gate
 *      would put an experimental VM flag under all 127 existing CJS suites for no
 *      benefit. A separate config keeps the blast radius at zero.
 *
 * Run: cd client/extension && npm test
 */
export default {
    rootDir: '.',
    testMatch: ['<rootDir>/tests/*.test.js'],
    testEnvironment: 'node',
    transform: {},          // no babel — these files ARE the shipped artifacts
};
