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
  UPLOAD_SESSION_UNSUPPORTED: 'upload.unsupported',
  UPLOAD_SESSION_NOT_FOUND: 'upload.sessionExpired',
  UPLOAD_SESSION_EXPIRED: 'upload.sessionExpired',
  UPLOAD_SESSION_INVALID: 'upload.sessionExpired',
  UPLOAD_PART_INVALID: 'upload.partRetry',
  UPLOAD_PART_BUSY: 'upload.busy',
  UPLOAD_INCOMPLETE: 'upload.incomplete',
  UPLOAD_PROVIDER_RATE_LIMITED: 'upload.providerRetryable',
  UPLOAD_PROVIDER_RETRYABLE: 'upload.providerRetryable',
  UPLOAD_PROVIDER_FAILED: 'upload.providerFailed',
  UPLOAD_PROVIDER_INVALID: 'upload.providerFailed',
  UPLOAD_STATE_PERSIST_FAILED: 'upload.providerRetryable',
  UPLOAD_ALREADY_COMPLETED: 'upload.alreadyCompleted',
  ONEDRIVE_UPLOAD_SESSION_NOT_FOUND: 'upload.sessionExpired',
  ONEDRIVE_UPLOAD_SESSION_PROOF_INVALID: 'upload.sessionExpired',
  ONEDRIVE_UPLOAD_SESSION_CONFLICT: 'upload.partRetry',
  ONEDRIVE_UPLOAD_SESSION_INVALID_RANGE: 'upload.partRetry',
  ONEDRIVE_UPLOAD_SESSION_RATE_LIMITED: 'upload.providerRetryable',
  ONEDRIVE_UPLOAD_SESSION_FAILED: 'upload.providerFailed',
  ONEDRIVE_UPLOAD_SESSION_INVALID: 'upload.providerFailed',
  INVALID_UPLOAD_PART_SIZE: 'upload.partRetry',
  INVALID_UPLOAD_CONTENT_TYPE: 'upload.partRetry',
};

export function localizedApiError(error: unknown, t: (key: MessageKey) => string, fallback: MessageKey): string {
  if (error instanceof ApiError) return t(API_ERROR_MESSAGES[error.code] ?? fallback);
  return t(fallback);
}
