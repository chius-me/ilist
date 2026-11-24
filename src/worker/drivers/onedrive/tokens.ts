import { createOAuthTokenManager, type OAuthCredentials } from '../../shared/oauth-tokens';
import { ONEDRIVE_SCOPES, requestOneDriveTokens } from './oauth';

export type OneDriveCredentials = OAuthCredentials;

const manager = createOAuthTokenManager({
  defaultScope: ONEDRIVE_SCOPES,
  notConnectedCode: 'ONEDRIVE_NOT_CONNECTED',
  notConnectedMessage: 'OneDrive mount is not connected',
  refreshBusyCode: 'ONEDRIVE_REFRESH_BUSY',
  refreshBusyMessage: 'OneDrive token refresh is busy',
  extraRefreshParams: { scope: ONEDRIVE_SCOPES },
  requestTokens: requestOneDriveTokens,
});

export const getOneDriveAccessToken = manager.getAccessToken;
export const refreshOneDriveAccessToken = manager.refreshToken;
