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
      throw new Error(response.data.error.message);
    }

    return response.data.result as T;
  } catch (err: any) {
    throw new Error(err.message || 'RPC Error');
  }
};
