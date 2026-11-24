import { consumeOAuthState } from '../../oauth-core';
import {
  buildOAuthAuthorizeUrl,
  exchangeOAuthTokens,
  oauthCallbackUrl,
  type OAuthProviderConfig,
  type OAuthTokenResponse,
} from '../../shared/oauth-provider';
import type { Env } from '../../types';

export const GOOGLE_DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type GoogleTokenResponse = OAuthTokenResponse;

const GOOGLE_OAUTH_CONFIG: OAuthProviderConfig = {
  driverType: 'google',
  callbackPath: '/api/admin/oauth/google/callback',
  authorizeUrl: GOOGLE_AUTHORIZE_URL,
  tokenUrl: GOOGLE_TOKEN_URL,
  scopes: GOOGLE_DRIVE_SCOPES,
  extraAuthorizeParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
  tokenErrorCode: 'GOOGLE_TOKEN_EXCHANGE_FAILED',
  providerLabel: 'Google',
};

export function googleDriveCallbackUrl(env: Env): string {
  return oauthCallbackUrl(env, GOOGLE_OAUTH_CONFIG);
}

export function createGoogleAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  return buildOAuthAuthorizeUrl(env, mountId, GOOGLE_OAUTH_CONFIG, now);
}

export function consumeGoogleOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  return consumeOAuthState(env, state, now);
}

export function requestGoogleTokens(
  env: Env,
  mountId: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  return exchangeOAuthTokens(env, mountId, GOOGLE_OAUTH_CONFIG, parameters, fetcher);
}
