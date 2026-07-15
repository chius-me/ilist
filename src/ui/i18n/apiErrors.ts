import { ApiError } from '../api/client';
import type { MessageKey } from './messages';

const API_ERROR_MESSAGES: Partial<Record<string, MessageKey>> = {
  INVALID_CREDENTIALS: 'error.invalidCredentials',
  AUTH_REQUIRED: 'error.authRequired',
  ENTRY_NAME_CONFLICT: 'dialog.nameConflict',
  INVALID_ENTRY_NAME: 'error.invalidName',
  OPERATION_LIMIT_EXCEEDED: 'error.operationLimit',
  STORAGE_OPERATION_FAILED: 'error.storageOperation',
  PROVIDER_OPERATION_FAILED: 'error.storageOperation',
  UPSTREAM_ERROR: 'error.storageOperation',
};

export function localizedApiError(error: unknown, t: (key: MessageKey) => string, fallback: MessageKey): string {
  if (error instanceof ApiError) return t(API_ERROR_MESSAGES[error.code] ?? fallback);
  return t(fallback);
}
