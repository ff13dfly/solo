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

function redirectToLogin() {
  clearSession();
  window.location.replace('/login');
}

export const callRpc = async <T>(method: string, params: any = {}): Promise<T> => {
  const token = getSession();

  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now()
  };

  try {
    const response = await axios.post<RpcResponse<T>>(getCurrentRouterUrl(), payload, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (response.data.error) {
      const code = response.data.error.code;
      // -32001 AUTH_REQUIRED, -32003 UNAUTHORIZED, -32005 FORBIDDEN
      if (code === -32001 || code === -32003 || code === 401 || code === 403) {
        redirectToLogin();
        return new Promise(() => {});
      }
      throw new Error(response.data.error.message);
    }

    return response.data.result as T;
  } catch (err: any) {
    // Server-side auth rejection → treat as expired and redirect.
    if (err.response?.status === 401 || err.response?.status === 403) {
      redirectToLogin();
      return new Promise(() => {});
    }
    throw new Error(err.response?.data?.error?.message || err.message || 'RPC Error');
  }
};
