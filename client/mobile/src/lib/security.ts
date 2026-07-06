// Web Crypto API helpers

export async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EncryptedData {
  ciphertext: string; // Hex string
  iv: string; // Hex string
  salt: string; // Hex string
}

export async function encryptPassword(password: string, pin: string): Promise<EncryptedData> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const key = await deriveKey(pin, salt);
  const encoder = new TextEncoder();
  
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
    },
    key,
    encoder.encode(password)
  );

  // Convert buffers to hex strings for storage
  return {
    ciphertext: bufferToHex(encrypted),
    iv: bufferToHex(iv),
    salt: bufferToHex(salt)
  };
}

export async function decryptPassword(data: EncryptedData, pin: string): Promise<string> {
  const salt = hexToBuffer(data.salt);
  const iv = hexToBuffer(data.iv);
  const ciphertext = hexToBuffer(data.ciphertext);
  
  const key = await deriveKey(pin, salt);
  
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
      },
      key,
      ciphertext as BufferSource
    );
    
    const result = new TextDecoder().decode(decrypted);
    return result;
  } catch (e) {
    throw new Error("Password decryption failed. Wrong PIN?");
  }
}

// Helpers
function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
