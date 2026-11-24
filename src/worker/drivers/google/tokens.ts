import { createOAuthTokenManager, type OAuthCredentials } from '../../shared/oauth-tokens';
import { GOOGLE_DRIVE_SCOPES, requestGoogleTokens } from './oauth';

export type GoogleCredentials = OAuthCredentials;

const manager = createOAuthTokenManager({
  defaultScope: GOOGLE_DRIVE_SCOPES,
  notConnectedCode: 'GOOGLE_NOT_CONNECTED',
  notConnectedMessage: 'Google Drive mount is not connected',
  refreshBusyCode: 'GOOGLE_REFRESH_BUSY',
  refreshBusyMessage: 'Google Drive token refresh is busy',
  requestTokens: requestGoogleTokens,
});

export const getGoogleAccessToken = manager.getAccessToken;
export const refreshGoogleAccessToken = manager.refreshToken;
