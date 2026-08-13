import { authorizationSecrets, getCredentials, patchCredentials } from '../../credentials';
import { HttpError } from '../../http';
import type { Env } from '../../types';
import { refreshPikPakToken } from './auth';

const REFRESH_SKEW_MS = 60_000;

export interface PikPakSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
}

function sessionFrom(credentials: Record<string, unknown> | null): PikPakSession {
  const auth = authorizationSecrets(credentials);
  if (typeof auth.refreshToken !== 'string' || !auth.refreshToken) {
    throw new HttpError(409, 'PIKPAK_NOT_CONNECTED', 'PikPak mount is not connected');
  }
  return {
    accessToken: typeof auth.accessToken === 'string' ? auth.accessToken : '',
    refreshToken: auth.refreshToken,
    tokenType: typeof auth.tokenType === 'string' ? auth.tokenType : 'Bearer',
    expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0,
  };
}

export async function getPikPakSession(env: Env, mountId: string, forceRefresh = false, fetcher: typeof fetch = fetch): Promise<PikPakSession> {
  const current = sessionFrom(await getCredentials(env, mountId));
  if (!forceRefresh && current.accessToken && current.expiresAt > Date.now() + REFRESH_SKEW_MS) return current;
  const next = await refreshPikPakToken(current.refreshToken, fetcher);
  await patchCredentials(env, mountId, { auth: next });
  return next;
}
