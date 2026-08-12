import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCredentials, putCredentials } from '../../src/worker/credentials';
import { getDropboxAccessToken } from '../../src/worker/drivers/dropbox/tokens';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;

async function mountWithTokens(expiresAt: number): Promise<string> {
  const mount = await createMount(workerEnv().DB, {
    name: `Dropbox token ${crypto.randomUUID()}`,
    mountPath: `/dropbox-token-${crypto.randomUUID()}`,
    driverType: 'dropbox', provider: 'dropbox', config: {},
  });
  await putCredentials(workerEnv(), mount.id, {
    accessToken: 'expired-dropbox-access', refreshToken: 'dropbox-refresh-1', tokenType: 'Bearer',
    expiresAt, scope: 'files.metadata.read files.metadata.write files.content.read files.content.write',
  });
  return mount.id;
}

describe('Dropbox token lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a valid access token without refreshing', async () => {
    await expect(getDropboxAccessToken(workerEnv(), await mountWithTokens(Date.now() + 10 * 60_000)))
      .resolves.toBe('expired-dropbox-access');
  });

  it('refreshes once under concurrency and retains an omitted refresh token', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    const tokenFetch = vi.fn(async () => Response.json({
      token_type: 'bearer', access_token: 'shared-dropbox-access', expires_in: 14400,
    }));
    vi.stubGlobal('fetch', tokenFetch);
    await expect(Promise.all([
      getDropboxAccessToken(workerEnv(), mountId),
      getDropboxAccessToken(workerEnv(), mountId),
    ])).resolves.toEqual(['shared-dropbox-access', 'shared-dropbox-access']);
    expect(tokenFetch).toHaveBeenCalledOnce();
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({ refreshToken: 'dropbox-refresh-1' });
  });

  it('does not expose token endpoint details', async () => {
    const mountId = await mountWithTokens(Date.now() - 1000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant', secret: 'private' }, { status: 400 })));
    const error = await getDropboxAccessToken(workerEnv(), mountId).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'DROPBOX_TOKEN_EXCHANGE_FAILED' });
    expect(String(error)).not.toContain('private');
  });
});
