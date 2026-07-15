import { decryptCredential, encryptCredential } from '../../crypto';
import { HttpError } from '../../http';
import type { Env } from '../../types';

export const ONEDRIVE_SCOPES = 'offline_access User.Read Files.ReadWrite';
export const ONEDRIVE_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const ONEDRIVE_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const STATE_TTL_MS = 10 * 60_000;

export interface OneDriveTokenResponse {
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

interface OAuthStateRow {
  state_hash: string;
  mount_id: string;
  verifier_ciphertext: string;
  expires_at: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export function publicOrigin(env: Env): string {
  let url: URL;
  try {
    url = new URL(env.PUBLIC_ORIGIN);
  } catch {
    throw new Error('PUBLIC_ORIGIN is invalid');
  }
  if (url.protocol !== 'https:' || url.origin !== env.PUBLIC_ORIGIN || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin');
  }
  return url.origin;
}

export function oneDriveCallbackUrl(env: Env): string {
  return `${publicOrigin(env)}/api/admin/oauth/onedrive/callback`;
}

export async function createOneDriveAuthorization(env: Env, mountId: string, now = Date.now()): Promise<string> {
  const state = randomToken();
  const verifier = randomToken();
  const stateHash = await sha256(state);
  const challenge = await sha256(verifier);
  const verifierCiphertext = await encryptCredential({ verifier }, env.CREDENTIAL_MASTER_KEY, `oauth-state:${stateHash}`);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE mount_id = ? OR expires_at <= ?').bind(mountId, now),
    env.DB.prepare(
      'INSERT INTO oauth_states (state_hash, mount_id, verifier_ciphertext, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(stateHash, mountId, verifierCiphertext, now + STATE_TTL_MS, new Date(now).toISOString()),
  ]);

  const authorization = new URL(ONEDRIVE_AUTHORIZE_URL);
  authorization.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID);
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
  if (!state) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  const stateHash = await sha256(state);
  const row = await env.DB.prepare(
    'SELECT state_hash, mount_id, verifier_ciphertext, expires_at FROM oauth_states WHERE state_hash = ?',
  ).bind(stateHash).first<OAuthStateRow>();
  if (!row) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(stateHash).run();
    throw new HttpError(400, 'OAUTH_STATE_EXPIRED', 'OAuth state has expired');
  }

  const consumed = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ?')
    .bind(stateHash, now).run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  }
  const decrypted = await decryptCredential(row.verifier_ciphertext, env.CREDENTIAL_MASTER_KEY, `oauth-state:${stateHash}`);
  if (!decrypted || typeof decrypted !== 'object' || typeof (decrypted as { verifier?: unknown }).verifier !== 'string') {
    throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid');
  }
  return { mountId: row.mount_id, verifier: (decrypted as { verifier: string }).verifier };
}

export async function requestOneDriveTokens(
  env: Env,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<OneDriveTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
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
