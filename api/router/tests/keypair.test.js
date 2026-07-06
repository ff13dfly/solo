const fs = require('fs');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

jest.mock('fs');

const MOCK_KEYPAIR_PATH = '/mock/.keypair';
const MOCK_PASSWORD_PATH = '/mock/.password';

describe('Keypair Handler', () => {

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        // Use env vars to fix paths — avoids path.join mock invalidation after resetModules
        process.env.SOLO_KEYPAIR_PATH = MOCK_KEYPAIR_PATH;
        process.env.SOLO_PASSWORD_PATH = MOCK_PASSWORD_PATH;
    });

    afterEach(() => {
        delete process.env.SOLO_KEYPAIR_PATH;
        delete process.env.SOLO_PASSWORD_PATH;
    });

    test('should generate and save plaintext keypair if not exists', () => {
        const fs = require('fs');
        fs.existsSync.mockReturnValue(false);
        fs.writeFileSync.mockImplementation(() => {});

        const { loadOrGenerateKeypair, getKeypair } = require('../handlers/keypair');
        loadOrGenerateKeypair(false);

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.keypair'),
            expect.stringContaining('[')
        );
        expect(getKeypair()).toBeDefined();
    });

    test('should load existing plaintext keypair', () => {
        const fs = require('fs');
        const kp = nacl.sign.keyPair();
        const secretArr = Array.from(kp.secretKey);

        fs.existsSync.mockImplementation((p) => p === MOCK_KEYPAIR_PATH);
        fs.readFileSync.mockImplementation((p) => {
            if (p === MOCK_KEYPAIR_PATH) return JSON.stringify(secretArr);
            return '';
        });

        const { loadOrGenerateKeypair, getKeypair } = require('../handlers/keypair');
        loadOrGenerateKeypair(false);

        const loaded = getKeypair();
        expect(loaded.publicKey.toBase58()).toBe(bs58.encode(kp.publicKey));
    });
});
