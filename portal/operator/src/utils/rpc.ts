import axios from 'axios';
import { getSession, clearSession } from './auth';
import { getCurrentRouterUrl } from './routerManager';

export { getCurrentRouterUrl as getRpcEndpoint } from './routerManager';

export interface RpcResponse<T> {
  jsonrpc: '2.0';
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: number | string | null;
}

/**
 * A failed RPC, with the JSON-RPC code kept intact.
 *
 * The code used to be dropped at the throw site, leaving callers a bare message —
 * so a permission denial was indistinguishable from any other failure, and pages
 * that only read `data` rendered "nothing here yet" over a Forbidden
 * (docs/feedback/done/operator-onboarding-three-silent-traps.md §二).
 */
export class RpcError extends Error {
  code?: number;
  data?: any;
  constructor(message: string, code?: number, data?: any) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** -32005 Forbidden: authenticated, but this account's permit doesn't cover the method. */
export const isForbidden = (err: unknown): boolean =>
  err instanceof RpcError && err.code === -32005;

export const callRpc = async <T>(method: string, params: any = {}): Promise<T> => {
  const token = getSession();

  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now()
  };

  const headers: any = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await axios.post<RpcResponse<T>>(getCurrentRouterUrl(), payload, { headers });

    if (response.data.error) {
      // Only -32001 (Unauthorized) should trigger logout.
      // -32604 (Forbidden) should just show an error message.
      if (response.data.error.code === -32001) {
        clearSession();
        window.location.href = '/login';
      }
      throw new RpcError(response.data.error.message, response.data.error.code, response.data.error.data);
    }

    return response.data.result as T;
  } catch (err: any) {
    if (err instanceof RpcError) throw err;   // keep the code through the catch
    throw new RpcError(err.message || 'RPC Error');
  }
};
