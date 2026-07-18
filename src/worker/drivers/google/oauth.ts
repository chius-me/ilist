import { HttpError } from '../../http';
import { consumeOAuthState, createOAuthState, publicOrigin } from '../../oauth-core';
import type { Env } from '../../types';

export const GOOGLE_DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleTokenResponse {
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

export function googleDriveCallbackUrl(env: Env): string {
  return `${publicOrigin(env)}/api/admin/oauth/google/callback`;
}

export async function createGoogleAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  const { state, challenge } = await createOAuthState(env, mountId, now);
  const authorization = new URL(GOOGLE_AUTHORIZE_URL);
  authorization.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('redirect_uri', googleDriveCallbackUrl(env));
  authorization.searchParams.set('scope', GOOGLE_DRIVE_SCOPES);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('access_type', 'offline');
  authorization.searchParams.set('prompt', 'consent');
  authorization.searchParams.set('include_granted_scopes', 'true');
  authorization.searchParams.set('code_challenge', challenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  return authorization.toString();
}

export function consumeGoogleOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  return consumeOAuthState(env, state, now);
}

export async function requestGoogleTokens(
  env: Env,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    ...parameters,
  });
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new HttpError(502, 'GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google token request failed');
  }
  if (!response.ok) throw new HttpError(502, 'GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google token request failed');

  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  const token = payload as Record<string, unknown> | null;
  if (!token || typeof token.access_token !== 'string' || typeof token.expires_in !== 'number') {
    throw new HttpError(502, 'GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google token response was invalid');
  }
  return {
    tokenType: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
    accessToken: token.access_token,
    ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    expiresIn: token.expires_in,
    ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
  };
}
