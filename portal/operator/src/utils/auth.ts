const SESSION_KEY = 'op_session_token';
const SESSION_USER_KEY = 'op_session_user';

export const setSession = (token: string) => {
  localStorage.setItem(SESSION_KEY, token);
};

export const getSession = (): string | null => {
  return localStorage.getItem(SESSION_KEY);
};

export const setSessionUser = (name: string) => {
  localStorage.setItem(SESSION_USER_KEY, name);
};

export const getSessionUser = (): string => {
  return localStorage.getItem(SESSION_USER_KEY) || '';
};

export const clearSession = () => {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_USER_KEY);
};

export const isValidSession = (): boolean => {
  return !!getSession();
};
