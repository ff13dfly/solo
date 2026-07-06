import crypto from 'crypto';

// Operator portal login hash: SHA256(password + saltHex).
// Mirrors portal/operator/src/utils/crypto.ts deriveLoginHash — keep in sync if you change it.
export function deriveUserHash(password: string, saltHex: string): string {
  return crypto.createHash('sha256').update(password + saltHex, 'utf8').digest('hex');
}

// Challenge-response: SHA256(challenge + loginHash).
export function computeResponse(challenge: string, loginHash: string): string {
  return crypto.createHash('sha256').update(challenge + loginHash, 'utf8').digest('hex');
}
