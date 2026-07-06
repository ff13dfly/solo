import crypto from 'crypto';

// System portal: PBKDF2(password + username, saltHex, iterations, SHA-256, 32 bytes)
// Mirrors portal/system/src/utils/crypto.ts deriveLoginHash
export function deriveAdminHash(password: string, username: string, saltHex: string, iterations: number): string {
  const key = Buffer.from(password + username, 'utf8');
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.pbkdf2Sync(key, salt, iterations, 32, 'sha256').toString('hex');
}

// Operator portal: SHA256(password + saltHex)
// Mirrors portal/operator/src/utils/crypto.ts deriveLoginHash
export function deriveUserHash(password: string, saltHex: string): string {
  return crypto.createHash('sha256').update(password + saltHex, 'utf8').digest('hex');
}

// Both portals: SHA256(challenge + loginHash)
export function computeResponse(challenge: string, loginHash: string): string {
  return crypto.createHash('sha256').update(challenge + loginHash, 'utf8').digest('hex');
}
