import { ApiError } from '../api/client';
import { localizedApiError } from '../i18n/apiErrors';
import type { useI18n } from '../i18n/I18nProvider';

type Translate = ReturnType<typeof useI18n>['t'];

export function directoryErrorTitle(error: Error, t: Translate): string {
  if (error instanceof ApiError && error.code === 'MOUNT_DISABLED') return t('state.disconnected');
  if (error instanceof ApiError && (error.status === 404 || error.code === 'ENTRY_NOT_FOUND' || error.code === 'MOUNT_NOT_FOUND')) {
    return t('state.unavailable');
  }
  return t('state.loadFailed');
}

export function directoryErrorHint(error: Error, t: Translate): string {
  if (error instanceof ApiError && error.code === 'MOUNT_DISABLED') return t('state.disconnectedHint');
  if (error instanceof ApiError && (error.status === 404 || error.code === 'ENTRY_NOT_FOUND' || error.code === 'MOUNT_NOT_FOUND')) {
    return t('state.unavailableHint');
  }
  return localizedApiError(error, t, 'state.loadFailed');
}
