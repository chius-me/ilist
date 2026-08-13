import { HttpError } from '../../http';
import type { PikPakTokenResponse } from './types';

export const PIKPAK_CLIENT_ID = 'YNxT9w7GMdWvEOKa';
export const PIKPAK_SIGN_IN_URL = 'https://user.mypikpak.net/v1/auth/signin';
export const PIKPAK_TOKEN_URL = 'https://user.mypikpak.net/v1/auth/token';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validToken(payload: PikPakTokenResponse | null, fallbackRefreshToken?: string): {
  accessToken: string; refreshToken: string; tokenType: string; expiresAt: number;
} {
  if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new HttpError(502, 'PIKPAK_TOKEN_RESPONSE_INVALID', 'PikPak token response was invalid');
  }
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) throw new HttpError(502, 'PIKPAK_TOKEN_RESPONSE_INVALID', 'PikPak token response was invalid');
  const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken,
    tokenType: payload.token_type ?? 'Bearer',
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function authenticationError(payload: Record<string, unknown> | null): HttpError {
  const reason = typeof payload?.error === 'string' ? payload.error : '';
  const code = typeof payload?.error_code === 'number' ? payload.error_code : undefined;
  return new HttpError(401, 'PIKPAK_AUTH_FAILED', 'PikPak authentication failed', {
    ...(reason && /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? { upstreamReason: reason } : {}),
    ...(Number.isSafeInteger(code) ? { upstreamCode: code } : {}),
  });
}

export async function authenticatePikPak(
  username: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<{ auth: ReturnType<typeof validToken>; username: string }> {
  let response: Response;
  try {
    response = await fetcher(PIKPAK_SIGN_IN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: PIKPAK_CLIENT_ID, username, password }),
    });
  } catch {
    throw new HttpError(502, 'PIKPAK_AUTH_UNAVAILABLE', 'PikPak authentication is unavailable');
  }
  const payload = await safeJson(response);
  if (!response.ok) throw authenticationError(payload);
  return { auth: validToken(payload as PikPakTokenResponse), username };
}

export async function refreshPikPakToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<ReturnType<typeof validToken>> {
  let response: Response;
  try {
    response = await fetcher(PIKPAK_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: PIKPAK_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
  } catch {
    throw new HttpError(502, 'PIKPAK_AUTH_UNAVAILABLE', 'PikPak authentication is unavailable');
  }
  const payload = await safeJson(response);
  if (!response.ok) throw new HttpError(401, 'PIKPAK_AUTH_EXPIRED', 'PikPak authentication expired');
  return validToken(payload as PikPakTokenResponse, refreshToken);
}
