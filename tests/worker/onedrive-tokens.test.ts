import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { putCredentials, getCredentials } from '../../src/worker/credentials';
import { createMount } from '../../src/worker/mounts';
import { getOneDriveAccessToken } from '../../src/worker/drivers/onedrive/tokens';
import type { Env } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;

async function mountWithTokens(expiresAt: number): Promise<string> {
  const mount = await createMount(workerEnv().DB, {
    name: `Token mount ${crypto.randomUUID()}`,
    mountPath: `/token-${crypto.randomUUID()}`,
    driverType: 'onedrive', provider: 'microsoft-onedrive-personal', config: {},
  });
  await putCredentials(workerEnv(), mount.id, {
    accessToken: 'expired-access', refreshToken: 'refresh-1', tokenType: 'Bearer', expiresAt,
    scope: 'offline_access User.Read Files.ReadWrite',
  });
  return mount.id;
}

describe('OneDrive token lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a still-valid access token without refreshing', async () => {
    const mountId = await mountWithTokens(Date.now() + 10 * 60_000);
    await expect(getOneDriveAccessToken(workerEnv(), mountId)).resolves.toBe('expired-access');
  });

  it('rotates refresh tokens and persists the new encrypted credential set', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        token_type: 'Bearer', access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200,
        scope: 'offline_access User.Read Files.ReadWrite',
      })));

    await expect(getOneDriveAccessToken(workerEnv(), mountId)).resolves.toBe('access-2');
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({
      accessToken: 'access-2', refreshToken: 'refresh-2', tokenType: 'Bearer',
    });
  });

  it('coalesces concurrent refreshes and releases its D1 lease', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    const tokenFetch = vi.fn(async () => Response.json({
        token_type: 'Bearer', access_token: 'shared-access', refresh_token: 'shared-refresh', expires_in: 3600,
      }));
    vi.stubGlobal('fetch', tokenFetch);

    await expect(Promise.all([
      getOneDriveAccessToken(workerEnv(), mountId),
      getOneDriveAccessToken(workerEnv(), mountId),
    ])).resolves.toEqual(['shared-access', 'shared-access']);
    expect(tokenFetch).toHaveBeenCalledOnce();
    const lease = await workerEnv().DB.prepare('SELECT mount_id FROM oauth_refresh_leases WHERE mount_id = ?').bind(mountId).first();
    expect(lease).toBeNull();
  });

  it('does not expose Microsoft token error details', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: 'invalid_grant', error_description: 'sensitive-refresh-token',
    }, { status: 400 })));

    const error = await getOneDriveAccessToken(workerEnv(), mountId).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'ONEDRIVE_TOKEN_EXCHANGE_FAILED' });
    expect(String(error)).not.toContain('sensitive-refresh-token');
  });
});
