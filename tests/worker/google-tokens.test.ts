import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCredentials, putCredentials } from '../../src/worker/credentials';
import { getGoogleAccessToken } from '../../src/worker/drivers/google/tokens';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;

async function mountWithTokens(expiresAt: number): Promise<string> {
  const mount = await createMount(workerEnv().DB, {
    name: `Google token mount ${crypto.randomUUID()}`,
    mountPath: `/google-token-${crypto.randomUUID()}`,
    driverType: 'google',
    provider: 'google',
    config: {},
  });
  await putCredentials(workerEnv(), mount.id, {
    accessToken: 'expired-google-access',
    refreshToken: 'google-refresh-1',
    tokenType: 'Bearer',
    expiresAt,
    scope: 'https://www.googleapis.com/auth/drive',
  });
  return mount.id;
}

describe('Google Drive token lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a still-valid access token without refreshing', async () => {
    const mountId = await mountWithTokens(Date.now() + 10 * 60_000);
    await expect(getGoogleAccessToken(workerEnv(), mountId)).resolves.toBe('expired-google-access');
  });

  it('rotates refresh tokens and persists the encrypted credential set', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      token_type: 'Bearer', access_token: 'google-access-2', refresh_token: 'google-refresh-2', expires_in: 7200,
      scope: 'https://www.googleapis.com/auth/drive',
    })));

    await expect(getGoogleAccessToken(workerEnv(), mountId)).resolves.toBe('google-access-2');
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({
      accessToken: 'google-access-2', refreshToken: 'google-refresh-2', tokenType: 'Bearer',
    });
  });

  it('retains the current refresh token when Google omits a replacement', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      token_type: 'Bearer', access_token: 'google-access-2', expires_in: 3600,
    })));

    await expect(getGoogleAccessToken(workerEnv(), mountId)).resolves.toBe('google-access-2');
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({ refreshToken: 'google-refresh-1' });
  });

  it('coalesces concurrent refreshes and releases its D1 lease', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    const tokenFetch = vi.fn(async () => Response.json({
      token_type: 'Bearer', access_token: 'shared-google-access', expires_in: 3600,
    }));
    vi.stubGlobal('fetch', tokenFetch);

    await expect(Promise.all([
      getGoogleAccessToken(workerEnv(), mountId),
      getGoogleAccessToken(workerEnv(), mountId),
    ])).resolves.toEqual(['shared-google-access', 'shared-google-access']);
    expect(tokenFetch).toHaveBeenCalledOnce();
    const lease = await workerEnv().DB.prepare('SELECT mount_id FROM oauth_refresh_leases WHERE mount_id = ?').bind(mountId).first();
    expect(lease).toBeNull();
  });

  it('does not expose Google token error details', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: 'invalid_grant', error_description: 'sensitive-google-refresh-token',
    }, { status: 400 })));

    const error = await getGoogleAccessToken(workerEnv(), mountId).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'GOOGLE_TOKEN_EXCHANGE_FAILED' });
    expect(String(error)).not.toContain('sensitive-google-refresh-token');
  });
});
