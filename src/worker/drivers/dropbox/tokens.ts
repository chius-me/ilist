import { createOAuthTokenManager, type OAuthCredentials } from '../../shared/oauth-tokens';
import { DROPBOX_SCOPES, requestDropboxTokens } from './oauth';

export type DropboxCredentials = OAuthCredentials;

const manager = createOAuthTokenManager({
  defaultScope: DROPBOX_SCOPES,
  notConnectedCode: 'DROPBOX_NOT_CONNECTED',
  notConnectedMessage: 'Dropbox mount is not connected',
  refreshBusyCode: 'DROPBOX_REFRESH_BUSY',
  refreshBusyMessage: 'Dropbox token refresh is busy',
  requestTokens: requestDropboxTokens,
});

export const getDropboxAccessToken = manager.getAccessToken;
export const refreshDropboxAccessToken = manager.refreshToken;
