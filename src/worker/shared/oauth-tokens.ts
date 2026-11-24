import { authorizationSecrets, getCredentials, patchCredentials } from '../credentials';
import { HttpError } from '../http';
import type { Env } from '../types';
import type { OAuthTokenResponse } from './oauth-provider';

export interface OAuthCredentials extends Record<string, unknown> {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
  scope: string;
}

export interface OAuthTokenManagerConfig {
  defaultScope: string;
  notConnectedCode: string;
  notConnectedMessage: string;
  refreshBusyCode: string;
  refreshBusyMessage: string;
  extraRefreshParams?: Record<string, string>;
  requestTokens: (
    env: Env,
    mountId: string,
    parameters: Record<string, string>,
    fetcher?: typeof fetch,
  ) => Promise<OAuthTokenResponse>;
}

const REFRESH_SKEW_MS = 60_000;
const REFRESH_LEASE_MS = 30_000;
const WAIT_BACKOFF_MS = [50, 100, 200, 400, 500, 500, 500, 500] as const;

export function createOAuthTokenManager(config: OAuthTokenManagerConfig) {
  function validCredentials(value: Record<string, unknown> | null): OAuthCredentials {
    const auth = authorizationSecrets(value);
    if (
      typeof auth.accessToken !== 'string'
      || typeof auth.refreshToken !== 'string'
      || typeof auth.expiresAt !== 'number'
    ) {
      throw new HttpError(409, config.notConnectedCode, config.notConnectedMessage);
    }
    return {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      tokenType: typeof auth.tokenType === 'string' ? auth.tokenType : 'Bearer',
      expiresAt: auth.expiresAt,
      scope: typeof auth.scope === 'string' ? auth.scope : config.defaultScope,
    };
  }

  function isFreshEnough(credentials: OAuthCredentials, rejectedAccessToken?: string): boolean {
    if (rejectedAccessToken !== undefined) {
      return credentials.accessToken !== rejectedAccessToken;
    }
    return credentials.expiresAt > Date.now() + REFRESH_SKEW_MS;
  }

  async function saveAuthorization(env: Env, mountId: string, next: OAuthCredentials): Promise<void> {
    await patchCredentials(env, mountId, {
      auth: next,
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      expiresAt: null,
      scope: null,
    });
  }

  async function acquireLease(env: Env, mountId: string, owner: string, now: number): Promise<boolean> {
    const result = await env.DB.prepare(
      `INSERT INTO oauth_refresh_leases (mount_id, owner, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(mount_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE oauth_refresh_leases.expires_at <= ?`,
    ).bind(mountId, owner, now + REFRESH_LEASE_MS, now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async function waitForRefresh(
    env: Env,
    mountId: string,
    rejectedAccessToken?: string,
  ): Promise<string> {
    for (const delayMs of WAIT_BACKOFF_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const credentials = validCredentials(await getCredentials(env, mountId));
      if (isFreshEnough(credentials, rejectedAccessToken)) {
        return credentials.accessToken;
      }
    }
    throw new HttpError(503, config.refreshBusyCode, config.refreshBusyMessage);
  }

  async function refreshAccessToken(
    env: Env,
    mountId: string,
    rejectedAccessToken?: string,
    fetcher: typeof fetch = fetch,
  ): Promise<string> {
    let credentials = validCredentials(await getCredentials(env, mountId));
    if (isFreshEnough(credentials, rejectedAccessToken)) {
      return credentials.accessToken;
    }

    const owner = crypto.randomUUID();
    if (!await acquireLease(env, mountId, owner, Date.now())) {
      return waitForRefresh(env, mountId, rejectedAccessToken);
    }

    try {
      credentials = validCredentials(await getCredentials(env, mountId));
      if (isFreshEnough(credentials, rejectedAccessToken)) {
        return credentials.accessToken;
      }
      const token = await config.requestTokens(env, mountId, {
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        ...(config.extraRefreshParams ?? {}),
      }, fetcher);
      const next: OAuthCredentials = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? credentials.refreshToken,
        tokenType: token.tokenType,
        expiresAt: Date.now() + token.expiresIn * 1000,
        scope: token.scope ?? credentials.scope,
      };
      await saveAuthorization(env, mountId, next);
      return next.accessToken;
    } finally {
      await env.DB.prepare('DELETE FROM oauth_refresh_leases WHERE mount_id = ? AND owner = ?')
        .bind(mountId, owner)
        .run();
    }
  }

  async function getAccessToken(env: Env, mountId: string): Promise<string> {
    const credentials = validCredentials(await getCredentials(env, mountId));
    if (credentials.expiresAt > Date.now() + REFRESH_SKEW_MS) return credentials.accessToken;
    return refreshAccessToken(env, mountId);
  }

  function refreshToken(
    env: Env,
    mountId: string,
    rejectedAccessToken: string,
    fetcher: typeof fetch = fetch,
  ): Promise<string> {
    return refreshAccessToken(env, mountId, rejectedAccessToken, fetcher);
  }

  return { getAccessToken, refreshToken };
}
