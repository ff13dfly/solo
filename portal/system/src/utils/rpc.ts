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
  // Vite 的 BASE_URL：默认构建是 '/'，子路径构建（vite build --base /system/）是
  // '/system/'。裸写 '/login' 的话，portal 挂在 solo.w3os.net/system/ 下时会跳到
  // 站点根，落进别的 app（或 404）。BASE_URL 自带结尾斜杠，直接拼即可。
  window.location.replace(`${import.meta.env.BASE_URL}login`);
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
