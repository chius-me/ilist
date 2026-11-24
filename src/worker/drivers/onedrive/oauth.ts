import { consumeOAuthState, publicOrigin } from '../../oauth-core';
import {
  buildOAuthAuthorizeUrl,
  exchangeOAuthTokens,
  oauthCallbackUrl,
  type OAuthProviderConfig,
  type OAuthTokenResponse,
} from '../../shared/oauth-provider';
import type { Env } from '../../types';

export const ONEDRIVE_SCOPES = 'offline_access User.Read Files.ReadWrite';
export const ONEDRIVE_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const ONEDRIVE_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

export type OneDriveTokenResponse = OAuthTokenResponse;

const ONEDRIVE_OAUTH_CONFIG: OAuthProviderConfig = {
  driverType: 'onedrive',
  callbackPath: '/api/admin/oauth/onedrive/callback',
  authorizeUrl: ONEDRIVE_AUTHORIZE_URL,
  tokenUrl: ONEDRIVE_TOKEN_URL,
  scopes: ONEDRIVE_SCOPES,
  extraAuthorizeParams: {
    response_mode: 'query',
  },
  tokenErrorCode: 'ONEDRIVE_TOKEN_EXCHANGE_FAILED',
  providerLabel: 'Microsoft',
};

export function oneDriveCallbackUrl(env: Env): string {
  return oauthCallbackUrl(env, ONEDRIVE_OAUTH_CONFIG);
}

export function createOneDriveAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  return buildOAuthAuthorizeUrl(env, mountId, ONEDRIVE_OAUTH_CONFIG, now);
}

export function consumeOneDriveOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  return consumeOAuthState(env, state, now);
}

export { publicOrigin };

export function requestOneDriveTokens(
  env: Env,
  mountId: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<OneDriveTokenResponse> {
  return exchangeOAuthTokens(env, mountId, ONEDRIVE_OAUTH_CONFIG, parameters, fetcher);
}
