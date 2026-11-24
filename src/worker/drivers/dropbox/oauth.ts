import { consumeOAuthState } from '../../oauth-core';
import {
  buildOAuthAuthorizeUrl,
  exchangeOAuthTokens,
  oauthCallbackUrl,
  type OAuthProviderConfig,
  type OAuthTokenResponse,
} from '../../shared/oauth-provider';
import type { Env } from '../../types';

export const DROPBOX_SCOPES = 'files.metadata.read files.metadata.write files.content.read files.content.write';
export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export type DropboxTokenResponse = OAuthTokenResponse;

const DROPBOX_OAUTH_CONFIG: OAuthProviderConfig = {
  driverType: 'dropbox',
  callbackPath: '/api/admin/oauth/dropbox/callback',
  authorizeUrl: DROPBOX_AUTHORIZE_URL,
  tokenUrl: DROPBOX_TOKEN_URL,
  scopes: DROPBOX_SCOPES,
  extraAuthorizeParams: {
    token_access_type: 'offline',
  },
  tokenErrorCode: 'DROPBOX_TOKEN_EXCHANGE_FAILED',
  providerLabel: 'Dropbox',
};

export function dropboxCallbackUrl(env: Env): string {
  return oauthCallbackUrl(env, DROPBOX_OAUTH_CONFIG);
}

export function createDropboxAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  return buildOAuthAuthorizeUrl(env, mountId, DROPBOX_OAUTH_CONFIG, now);
}

export function consumeDropboxOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  return consumeOAuthState(env, state, now);
}

export function requestDropboxTokens(
  env: Env,
  mountId: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<DropboxTokenResponse> {
  return exchangeOAuthTokens(env, mountId, DROPBOX_OAUTH_CONFIG, parameters, fetcher);
}
