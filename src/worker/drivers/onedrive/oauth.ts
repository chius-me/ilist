import { HttpError } from '../../http';
import { consumeOAuthState, createOAuthState, publicOrigin } from '../../oauth-core';
import type { Env } from '../../types';
import { resolveOAuthApplication } from '../../oauth-credentials';

export const ONEDRIVE_SCOPES = 'offline_access User.Read Files.ReadWrite';
export const ONEDRIVE_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const ONEDRIVE_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

export interface OneDriveTokenResponse {
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

export function oneDriveCallbackUrl(env: Env): string {
  return `${publicOrigin(env)}/api/admin/oauth/onedrive/callback`;
}

export async function createOneDriveAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  const application = await resolveOAuthApplication(env, mountId, 'onedrive');
  const { state, challenge } = await createOAuthState(env, mountId, now);

  const authorization = new URL(ONEDRIVE_AUTHORIZE_URL);
  authorization.searchParams.set('client_id', application.clientId);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('redirect_uri', oneDriveCallbackUrl(env));
  authorization.searchParams.set('response_mode', 'query');
  authorization.searchParams.set('scope', ONEDRIVE_SCOPES);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('code_challenge', challenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  return authorization.toString();
}

export async function consumeOneDriveOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  return consumeOAuthState(env, state, now);
}

export { publicOrigin } from '../../oauth-core';

export async function requestOneDriveTokens(
  env: Env,
  mountId: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<OneDriveTokenResponse> {
  const application = await resolveOAuthApplication(env, mountId, 'onedrive');
  const body = new URLSearchParams({
    client_id: application.clientId,
    client_secret: application.clientSecret,
    ...parameters,
  });
  let response: Response;
  try {
    response = await fetcher(ONEDRIVE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new HttpError(502, 'ONEDRIVE_TOKEN_EXCHANGE_FAILED', 'Microsoft token request failed');
  }
  if (!response.ok) throw new HttpError(502, 'ONEDRIVE_TOKEN_EXCHANGE_FAILED', 'Microsoft token request failed');

  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  const token = payload as Record<string, unknown> | null;
  if (!token || typeof token.access_token !== 'string' || typeof token.expires_in !== 'number') {
    throw new HttpError(502, 'ONEDRIVE_TOKEN_EXCHANGE_FAILED', 'Microsoft token response was invalid');
  }
  return {
    tokenType: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
    accessToken: token.access_token,
    ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    expiresIn: token.expires_in,
    ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
  };
}
