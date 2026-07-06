const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

// Resolve relative to __dirname so the path is absolute and always points to the router root.
// __dirname is api/core/router/handlers. We want the files in api/core/router/
const ROUTER_ROOT = path.resolve(__dirname, '..');
const KEYPAIR_PATH = process.env.SOLO_KEYPAIR_PATH || path.join(ROUTER_ROOT, '.keypair');
const PASSWORD_PATH = process.env.SOLO_PASSWORD_PATH || path.join(ROUTER_ROOT, '.password');

let activeKeypair = null;

// Preserve the @solana/web3.js Keypair surface this module used to expose, now backed by
// tweetnacl + bs58 (drops the ~14MB @solana dep from every bundle — it was the last consumer).
// Consumers only ever touch getKeypair().secretKey (tweetnacl signing in forward.js) and
// getKeypair().publicKey.toBase58() (index.js /publickey route + service.js handshake). secretKey
// is the standard 64-byte Ed25519 secret (32 seed + 32 public) — identical layout to @solana's,
// so existing on-disk .keypair files stay byte-compatible (no key rotation needed on upgrade).
function wrapKeypair(secretKey) {
    const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
    return {
        secretKey: kp.secretKey,
        publicKey: {
            toBytes: () => kp.publicKey,
            toBase58: () => bs58.encode(kp.publicKey),
        },
    };
}

// --- IDENTITY MANAGEMENT ---

/**
 * Load the existing identity keypair or generate a fresh one if missing.
 * 
 * @param {boolean} debug - If true, encrypts the keypair on disk for local security tests.
 * 
 * @why This keypair is the "Router's Identity". It's used to sign all forwarded requests 
 *      (Level 3 Security), allowing downstream services to verify that a request truly 
 *      came through the authorized entry point.
 * @attention 
 *   1. PERSISTENCE: The secret key is stored in `.keypair`. If lost, all downstream 
 *      services will reject signatures until they are updated with the new public key.
 *   2. ENCRYPTION: Supports an auto-detecting AES-256-CTR encryption scheme if a 
 *      `.password` file is present.
 */
function loadOrGenerateKeypair(debug = false) {
    let secretKey;

    if (fs.existsSync(KEYPAIR_PATH)) {
        const fileContent = fs.readFileSync(KEYPAIR_PATH, 'utf8');
        
        try {
            const parsed = JSON.parse(fileContent);
            
            // Auto-detect format: Encrypted (v2) vs Plaintext (v1)
            if (parsed.iv && parsed.content && fs.existsSync(PASSWORD_PATH)) {
                // Decrypt using the stored password
                const password = fs.readFileSync(PASSWORD_PATH, 'utf8');
                const algorithm = 'aes-256-ctr';
                const key = crypto.scryptSync(password, 'salt', 32);
                const iv = Buffer.from(parsed.iv, 'hex');
                const decipher = crypto.createDecipheriv(algorithm, key, iv);
                const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.content, 'hex')), decipher.final()]);
                secretKey = new Uint8Array(JSON.parse(decrypted.toString()));
                console.log('[Identity] Keypair decrypted and loaded.');
            } else if (Array.isArray(parsed)) {
                // Plaintext byte array
                secretKey = new Uint8Array(parsed);
                console.log('[Identity] Keypair loaded (plaintext/unsecured).');
            } else if (parsed.iv && parsed.content && !fs.existsSync(PASSWORD_PATH)) {
                console.error('[Identity] FATAL: Keypair is encrypted but .password file is missing.');
                process.exit(1);
            } else {
                console.error('[Identity] FATAL: Invalid keypair file format.');
                process.exit(1);
            }
        } catch (e) {
            console.error('[Identity] FATAL: Failed to parse keypair file:', e.message);
            process.exit(1);
        }
    } else {
        // Bootstrap: Generate first-time identity
        const generated = nacl.sign.keyPair();
        secretKey = generated.secretKey;
        const secretKeyArray = Array.from(secretKey);

        if (debug) {
            // Secure storage for local debug mode
            const password = crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(PASSWORD_PATH, password);
            
            const algorithm = 'aes-256-ctr';
            const key = crypto.scryptSync(password, 'salt', 32);
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(algorithm, key, iv);
            const encrypted = Buffer.concat([cipher.update(JSON.stringify(secretKeyArray)), cipher.final()]);
            
            const fileData = JSON.stringify({
                iv: iv.toString('hex'),
                content: encrypted.toString('hex')
            });
            fs.writeFileSync(KEYPAIR_PATH, fileData);
            console.log('[Identity] Generated new encrypted identity.');
        } else {
            // Simple storage for development
            fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(secretKeyArray));
            console.log('[Identity] Generated new plaintext identity (Insecure).');
        }
    }

    if (secretKey) {
        activeKeypair = wrapKeypair(secretKey);
    }
    
    if (activeKeypair) {
        console.log('[Identity] Local Public Key:', activeKeypair.publicKey.toBase58());
    }
}

// --- ACCESSORS ---

/**
 * Retrieve the active Ed25519 keypair for request signing.
 */
function getKeypair() {
    return activeKeypair;
}

module.exports = {
    loadOrGenerateKeypair,
    getKeypair
};
