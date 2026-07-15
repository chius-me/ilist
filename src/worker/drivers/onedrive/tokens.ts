import { getCredentials, putCredentials } from '../../credentials';
import { HttpError } from '../../http';
import type { Env } from '../../types';
import { ONEDRIVE_SCOPES, requestOneDriveTokens } from './oauth';

export interface OneDriveCredentials extends Record<string, unknown> {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
  scope: string;
}

const REFRESH_SKEW_MS = 60_000;
const REFRESH_LEASE_MS = 30_000;

function validCredentials(value: Record<string, unknown> | null): OneDriveCredentials {
  if (
    !value
    || typeof value.accessToken !== 'string'
    || typeof value.refreshToken !== 'string'
    || typeof value.expiresAt !== 'number'
  ) throw new HttpError(409, 'ONEDRIVE_NOT_CONNECTED', 'OneDrive mount is not connected');
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    tokenType: typeof value.tokenType === 'string' ? value.tokenType : 'Bearer',
    expiresAt: value.expiresAt,
    scope: typeof value.scope === 'string' ? value.scope : ONEDRIVE_SCOPES,
  };
}

async function acquireLease(env: Env, mountId: string, owner: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO oauth_refresh_leases (mount_id, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(mount_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE oauth_refresh_leases.expires_at <= ?`,
  ).bind(mountId, owner, now + REFRESH_LEASE_MS, now).run();
  return (result.meta.changes ?? 0) === 1;
}

async function waitForRefresh(env: Env, mountId: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const credentials = validCredentials(await getCredentials(env, mountId));
    if (credentials.expiresAt > Date.now() + REFRESH_SKEW_MS) return credentials.accessToken;
  }
  throw new HttpError(503, 'ONEDRIVE_REFRESH_BUSY', 'OneDrive token refresh is busy');
}

async function refreshAccessToken(env: Env, mountId: string): Promise<string> {
  let credentials = validCredentials(await getCredentials(env, mountId));
  if (credentials.expiresAt > Date.now() + REFRESH_SKEW_MS) return credentials.accessToken;

  const owner = crypto.randomUUID();
  if (!await acquireLease(env, mountId, owner, Date.now())) return waitForRefresh(env, mountId);
  try {
    credentials = validCredentials(await getCredentials(env, mountId));
    if (credentials.expiresAt > Date.now() + REFRESH_SKEW_MS) return credentials.accessToken;
    const token = await requestOneDriveTokens(env, {
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: ONEDRIVE_SCOPES,
    });
    const next: OneDriveCredentials = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? credentials.refreshToken,
      tokenType: token.tokenType,
      expiresAt: Date.now() + token.expiresIn * 1000,
      scope: token.scope ?? credentials.scope,
    };
    await putCredentials(env, mountId, next);
    return next.accessToken;
  } finally {
    await env.DB.prepare('DELETE FROM oauth_refresh_leases WHERE mount_id = ? AND owner = ?').bind(mountId, owner).run();
  }
}

export async function getOneDriveAccessToken(env: Env, mountId: string): Promise<string> {
  const credentials = validCredentials(await getCredentials(env, mountId));
  if (credentials.expiresAt > Date.now() + REFRESH_SKEW_MS) return credentials.accessToken;
  return refreshAccessToken(env, mountId);
}
