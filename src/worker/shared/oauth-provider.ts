import { HttpError } from '../http';
import { createOAuthState, publicOrigin } from '../oauth-core';
import { resolveOAuthApplication, type OAuthDriverType } from '../oauth-credentials';
import type { Env } from '../types';
import { DEFAULT_METADATA_TIMEOUT_MS, fetchWithRetry } from './http-client';

export interface OAuthTokenResponse {
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

export interface OAuthProviderConfig {
  driverType: OAuthDriverType;
  callbackPath: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  extraAuthorizeParams?: Record<string, string>;
  tokenErrorCode: string;
  providerLabel: string;
}

export function oauthCallbackUrl(env: Env, config: Pick<OAuthProviderConfig, 'callbackPath'>): string {
  return `${publicOrigin(env)}${config.callbackPath}`;
}

export async function buildOAuthAuthorizeUrl(
  env: Env,
  mountId: string,
  config: OAuthProviderConfig,
  now = Date.now(),
): Promise<string> {
  const application = await resolveOAuthApplication(env, mountId, config.driverType);
  const { state, challenge } = await createOAuthState(env, mountId, now);
  const authorization = new URL(config.authorizeUrl);
  authorization.searchParams.set('client_id', application.clientId);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('redirect_uri', oauthCallbackUrl(env, config));
  authorization.searchParams.set('scope', config.scopes);
  authorization.searchParams.set('state', state);
  if (config.extraAuthorizeParams) {
    for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
      authorization.searchParams.set(key, value);
    }
  }
  authorization.searchParams.set('code_challenge', challenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  return authorization.toString();
}

export async function exchangeOAuthTokens(
  env: Env,
  mountId: string,
  config: OAuthProviderConfig,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<OAuthTokenResponse> {
  const application = await resolveOAuthApplication(env, mountId, config.driverType);
  const body = new URLSearchParams({
    client_id: application.clientId,
    client_secret: application.clientSecret,
    ...parameters,
  });

  let response: Response;
  try {
    response = await fetchWithRetry(fetcher, config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: DEFAULT_METADATA_TIMEOUT_MS,
    });
  } catch {
    throw new HttpError(502, config.tokenErrorCode, `${config.providerLabel} token request failed`);
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new HttpError(502, config.tokenErrorCode, `${config.providerLabel} token request failed`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const token = payload as Record<string, unknown> | null;
  if (!token || typeof token.access_token !== 'string' || typeof token.expires_in !== 'number') {
    throw new HttpError(502, config.tokenErrorCode, `${config.providerLabel} token response was invalid`);
  }
  return {
    tokenType: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
    accessToken: token.access_token,
    ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    expiresIn: token.expires_in,
    ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
  };
}
