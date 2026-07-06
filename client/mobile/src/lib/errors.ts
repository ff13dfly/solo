/**
 * Standardized Application Errors
 */

export const ErrorSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'fatal'
} as const;

export type ErrorSeverity = typeof ErrorSeverity[keyof typeof ErrorSeverity];

export const ErrorCode = {
  // Network / Server
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_SERVER_ERROR: 'API_SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  
  // Auth
  AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  
  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  
  // Business
  WORKFLOW_EXECUTION_FAILED: 'WORKFLOW_EXECUTION_FAILED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// Map codes to default messages (English for now, i18n key in future)
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.NETWORK_ERROR]: 'Network connection error (网络连接异常)',
  [ErrorCode.API_SERVER_ERROR]: 'Server encountered an error (服务器内部错误)',
  [ErrorCode.TIMEOUT]: 'Request timed out (请求超时)',
  [ErrorCode.AUTH_LOGIN_FAILED]: 'Login failed (登录失败)',
  [ErrorCode.AUTH_UNAUTHORIZED]: 'Session expired or invalid (会话已过期)',
  [ErrorCode.AUTH_FORBIDDEN]: 'Permission denied (权限不足)',
  [ErrorCode.VALIDATION_ERROR]: 'Validation failed (数据验证失败)',
  [ErrorCode.INVALID_INPUT]: 'Invalid input provided (无效的输入)',
  [ErrorCode.WORKFLOW_EXECUTION_FAILED]: 'Workflow execution failed (工作流执行失败)',
  [ErrorCode.UNKNOWN_ERROR]: 'An unknown error occurred (发生未知错误)'
};

export class AppError extends Error {
  code: ErrorCode;
  severity: ErrorSeverity;
  originalError?: unknown;

  constructor(code: ErrorCode, message?: string, options?: { severity?: ErrorSeverity, originalError?: unknown }) {
    super(message || DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.severity = options?.severity || ErrorSeverity.ERROR;
    this.originalError = options?.originalError;
  }
}

// Helper to normalize unknown errors into AppError
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new AppError(ErrorCode.UNKNOWN_ERROR, error.message, { originalError: error });
  }
  
  return new AppError(ErrorCode.UNKNOWN_ERROR, String(error), { originalError: error });
}
