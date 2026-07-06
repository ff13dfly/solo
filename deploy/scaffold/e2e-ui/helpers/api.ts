import { deriveUserHash, computeResponse } from './crypto';

const ROUTER_URL = process.env.SOLO_ROUTER_URL || 'http://localhost:8600';

async function rpc(method: string, params: Record<string, unknown>, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(ROUTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} calling ${method}`);
  const data = (await res.json()) as any;
  if (data.error) throw new Error(`RPC ${method} error: ${data.error.message}`);
  return data.result;
}

// Operator portal: user.login.* (SHA-256 challenge-response).
export async function loginUser(name: string, password: string): Promise<string> {
  const { salt, challenge } = await rpc('user.login.request', { name });
  const hash = deriveUserHash(password, salt);
  const response = computeResponse(challenge, hash);
  const result = await rpc('user.login.verify', { name, challenge, response, deviceId: 'e2e-playwright' });
  if (!result.success) throw new Error('User login rejected by server');
  return result.token as string;
}
