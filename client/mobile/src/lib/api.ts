// import API_CONFIG from '../config';
import { AppError, ErrorCode, ErrorSeverity } from './errors';
import { getCurrentRouterUrl } from './routerManager';

export async function registerUser(username: string, password: string, phone: string) {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const url = getCurrentRouterUrl();
  const body = {
    jsonrpc: '2.0',
    method: 'user.register',
    params: { name: username, phone, salt, hash },
    id: Date.now()
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new AppError(ErrorCode.API_SERVER_ERROR, `HTTP Error: ${response.status}`);
    }

    const result = await response.json();
    if (result.error) {
        throw new AppError(ErrorCode.AUTH_LOGIN_FAILED, result.error.message || 'Registration failed');
    }
    return result.result;

  } catch (error: any) {
    if (error instanceof AppError) throw error;
    throw new AppError(ErrorCode.NETWORK_ERROR, error.message, { originalError: error });
  }
}

async function sha256(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function loginUser(username: string, password: string) {
  const url = getCurrentRouterUrl();

  try {
    // 1. Request Challenge
    const req1 = {
        jsonrpc: '2.0',
        method: 'user.login.request',
        params: { name: username },
        id: Date.now()
    };
    
    const res1 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req1)
    });
    
    if (!res1.ok) throw new AppError(ErrorCode.API_SERVER_ERROR, `HTTP Error: ${res1.status}`);

    const data1 = await res1.json();
    if (data1.error) {
        throw new AppError(ErrorCode.AUTH_LOGIN_FAILED, data1.error.message || 'Login request failed');
    }
    
    const { challenge, salt } = data1.result;

    // 2. Compute Response
    const hash = await sha256(password + salt);
    const response = await sha256(challenge + hash);

    // 3. Verify
    const req2 = {
        jsonrpc: '2.0',
        method: 'user.login.verify',
        params: { 
            name: username,
            challenge,
            response,
            deviceId: 'mobile_web'
        },
        id: Date.now() + 1
    };

    const res2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req2)
    });

    if (!res2.ok) throw new AppError(ErrorCode.API_SERVER_ERROR, `HTTP Error: ${res2.status}`);

    const data2 = await res2.json();
    if (data2.error) {
        throw new AppError(ErrorCode.AUTH_LOGIN_FAILED, data2.error.message || 'Login verify failed');
    }

    // Save Token
    if (data2.result && data2.result.token) {
        localStorage.setItem("auth_token", data2.result.token);
    }

    return data2.result;

  } catch (error: any) {
    if (error instanceof AppError) throw error;
    // Map network errors
    if (error.message.includes('fetch') || error.message.includes('network')) {
        throw new AppError(ErrorCode.NETWORK_ERROR, '网络连接失败，请检查网络设置', { originalError: error });
    }
    throw new AppError(ErrorCode.UNKNOWN_ERROR, error.message, { originalError: error });
  }
}

export async function callRpc<T = any>(method: string, params: any = {}): Promise<T> {
  const url = getCurrentRouterUrl();
  const token = localStorage.getItem("auth_token");
  
  const body = {
    jsonrpc: '2.0',
    method: method,
    params: params,
    id: Date.now()
  };

  const headers: Record<string, string> = {
      'Content-Type': 'application/json',
  };
  if (token) {
      headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new AppError(ErrorCode.AUTH_UNAUTHORIZED, '登录已过期，请重新登录', { severity: ErrorSeverity.WARNING });
        }
        throw new AppError(ErrorCode.API_SERVER_ERROR, `HTTP Error: ${response.status}`);
    }
    
    const result = await response.json();
    if (result.error) {
        // Check for specific error codes if available from server
        // For now, treat as generic API error, but could map codes if server sends them
        throw new AppError(ErrorCode.API_SERVER_ERROR, result.error.message || 'Agent call failed');
    }
    return result.result;

  } catch (error: any) {
     if (error instanceof AppError) throw error;
     if (error.message.includes('fetch') || error.message.includes('network')) {
        throw new AppError(ErrorCode.NETWORK_ERROR, '网络连接失败', { originalError: error });
    }
     throw new AppError(ErrorCode.UNKNOWN_ERROR, error.message, { originalError: error });
  }
}

export async function fetchCapabilities() {
  return callRpc('system.capability.list', {});
}

export async function fetchWorkflows() {
  return callRpc('system.workflow.list', {});
}

export const callAgent = callRpc;
