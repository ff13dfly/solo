/**
 * Simple RPC client for Flow SPA
 */

const DEFAULT_ROUTER = 'http://localhost:8600/';

export async function callRpc(method, params = {}) {
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now()
  };

  try {
    const response = await fetch(DEFAULT_ROUTER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    return data.result;
  } catch (err) {
    console.error('[RPC ERROR]', err);
    throw err;
  }
}
