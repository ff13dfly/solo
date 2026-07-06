/**
 * Crypto helpers for the real login flow (§4).
 *   register:  hash = SHA256(password + salt)
 *   login:     response = SHA256(challenge + hash)
 * 对称 SHA-256 挑战-响应 —— 没有 keypair / 公钥 / 签名(Ed25519 只用于 Router→服务传输层).
 */
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomHex = (n = 16) => crypto.randomBytes(n).toString('hex');

module.exports = { sha256, randomHex };
