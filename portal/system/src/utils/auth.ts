const SESSION_KEY = 'sys_session_token';
const SESSION_TIME_KEY = 'sys_session_ts';
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes (Must match api/core/administrator/config.js sessionTtl)

export const setSession = (token: string) => {
  localStorage.setItem(SESSION_KEY, token);
  localStorage.setItem(SESSION_TIME_KEY, Date.now().toString());
};

export const getSession = (): string | null => {
  const token = localStorage.getItem(SESSION_KEY);
  const ts = localStorage.getItem(SESSION_TIME_KEY);

  if (!token || !ts) return null;

  const age = Date.now() - parseInt(ts, 10);
  if (age > EXPIRY_MS) {
    clearSession();
    return null;
  }

  // Refresh TS on active use? "validity for 30 minutes" usually means absolute or rolling.
  // I will implement absolute 30 min from login for "temporary session verification" as requested literally.
  // Or rolling? "有效期为30分钟" (valid for 30 mins). Usually implies timeout.
  // Let's stick to absolute for strictness, or rolling if user interacts? 
  // Simple version: 30 mins from login. 
  
  return token;
};

export const clearSession = () => {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_TIME_KEY);
};

export const isValidSession = (): boolean => {
  return !!getSession();
};
