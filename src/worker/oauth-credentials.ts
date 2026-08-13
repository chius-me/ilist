import { getCredentials, oauthApplicationCredentials, type OAuthApplicationCredentials } from './credentials';
import { HttpError } from './http';
import type { Env, MountDriverType } from './types';

export type OAuthDriverType = Extract<MountDriverType, 'dropbox' | 'google' | 'onedrive'>;

export interface ResolvedOAuthApplication extends OAuthApplicationCredentials {
  source: 'mount' | 'legacy';
}

function legacyApplication(env: Env, driver: OAuthDriverType): OAuthApplicationCredentials | null {
  const pair = driver === 'dropbox'
    ? [env.DROPBOX_CLIENT_ID, env.DROPBOX_CLIENT_SECRET]
    : driver === 'google'
      ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
      : [env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET];
  return typeof pair[0] === 'string' && pair[0] && typeof pair[1] === 'string' && pair[1]
    ? { clientId: pair[0], clientSecret: pair[1] }
    : null;
}

export async function resolveOAuthApplication(
  env: Env,
  mountId: string,
  driver: OAuthDriverType,
): Promise<ResolvedOAuthApplication> {
  const mountApplication = oauthApplicationCredentials(await getCredentials(env, mountId));
  if (mountApplication) return { ...mountApplication, source: 'mount' };
  const legacy = legacyApplication(env, driver);
  if (legacy) return { ...legacy, source: 'legacy' };
  throw new HttpError(
    409,
    'OAUTH_APP_NOT_CONFIGURED',
    'OAuth application credentials are not configured for this mount',
  );
}

export async function oauthApplicationSource(
  env: Env,
  mountId: string,
  driver: OAuthDriverType,
): Promise<'mount' | 'legacy' | 'missing'> {
  if (oauthApplicationCredentials(await getCredentials(env, mountId))) return 'mount';
  return legacyApplication(env, driver) ? 'legacy' : 'missing';
}
