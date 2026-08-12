import { HttpError } from '../../http';
import { consumeOAuthState, createOAuthState, publicOrigin } from '../../oauth-core';
import type { Env } from '../../types';

export const DROPBOX_SCOPES = 'files.metadata.read files.metadata.write files.content.read files.content.write';
export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export interface DropboxTokenResponse {
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

export function dropboxCallbackUrl(env: Env): string {
  return `${publicOrigin(env)}/api/admin/oauth/dropbox/callback`;
}

export async function createDropboxAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  const { state, challenge } = await createOAuthState(env, mountId, now);
  const authorization = new URL(DROPBOX_AUTHORIZE_URL);
  authorization.searchParams.set('client_id', env.DROPBOX_CLIENT_ID);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('redirect_uri', dropboxCallbackUrl(env));
  authorization.searchParams.set('scope', DROPBOX_SCOPES);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('token_access_type', 'offline');
  authorization.searchParams.set('code_challenge', challenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  return authorization.toString();
}

export function consumeDropboxOAuthState(
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ mountId: string; verifier: string }> {
  return consumeOAuthState(env, state, now);
}

export async function requestDropboxTokens(
  env: Env,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<DropboxTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.DROPBOX_CLIENT_ID,
    client_secret: env.DROPBOX_CLIENT_SECRET,
    ...parameters,
  });
  let response: Response;
  try {
    response = await fetcher(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new HttpError(502, 'DROPBOX_TOKEN_EXCHANGE_FAILED', 'Dropbox token request failed');
  }
  if (!response.ok) throw new HttpError(502, 'DROPBOX_TOKEN_EXCHANGE_FAILED', 'Dropbox token request failed');

  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  const token = payload as Record<string, unknown> | null;
  if (!token || typeof token.access_token !== 'string' || typeof token.expires_in !== 'number') {
    throw new HttpError(502, 'DROPBOX_TOKEN_EXCHANGE_FAILED', 'Dropbox token response was invalid');
  }
  return {
    tokenType: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
    accessToken: token.access_token,
    ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    expiresIn: token.expires_in,
    ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
  };
}
