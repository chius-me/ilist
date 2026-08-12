import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCredentials } from '../../src/worker/credentials';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const workerEnv = () => env as unknown as Env;

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '127.0.0.1', 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function createDropboxMount(): Promise<string> {
  return (await createMount(workerEnv().DB, {
    name: `Dropbox ${crypto.randomUUID()}`,
    mountPath: `/dropbox-${crypto.randomUUID()}`,
    driverType: 'dropbox',
    provider: 'dropbox',
    config: {},
  })).id;
}

async function start(mountId: string): Promise<Response> {
  const cookie = await login();
  return SELF.fetch(`${origin}/api/admin/oauth/dropbox/start?mountId=${encodeURIComponent(mountId)}`, {
    headers: { cookie }, redirect: 'manual',
  });
}

describe('Dropbox OAuth routes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds an offline PKCE authorization URL with file scopes', async () => {
    const response = await start(await createDropboxMount());
    expect(response.status).toBe(302);
    const authorization = new URL(response.headers.get('location')!);
    expect(`${authorization.origin}${authorization.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${origin}/api/admin/oauth/dropbox/callback`);
    expect(authorization.searchParams.get('token_access_type')).toBe('offline');
    expect(authorization.searchParams.get('scope')).toContain('files.content.write');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('consumes state once, stores encrypted tokens, and redirects to storage settings', async () => {
    const mountId = await createDropboxMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const state = authorization.searchParams.get('state')!;
    const tokenFetch = vi.fn(async () => Response.json({
      token_type: 'bearer', access_token: 'dropbox-access', refresh_token: 'dropbox-refresh', expires_in: 14400,
      scope: 'files.metadata.read files.metadata.write files.content.read files.content.write',
    }));
    vi.stubGlobal('fetch', tokenFetch);
    const cookie = await login();

    const callback = await SELF.fetch(`${origin}/api/admin/oauth/dropbox/callback?code=code-1&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/admin/storages?dropbox=connected`);
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({
      accessToken: 'dropbox-access', refreshToken: 'dropbox-refresh', tokenType: 'bearer',
    });
    const stored = await workerEnv().DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?')
      .bind(mountId).first<{ ciphertext: string }>();
    expect(stored!.ciphertext).not.toContain('dropbox-refresh');

    const replay = await SELF.fetch(`${origin}/api/admin/oauth/dropbox/callback?code=code-2&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(replay.status).toBe(400);
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it('consumes denied authorization state and returns a concise status', async () => {
    const mountId = await createDropboxMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const response = await SELF.fetch(`${origin}/api/admin/oauth/dropbox/callback?error=access_denied&state=${authorization.searchParams.get('state')}`, {
      headers: { cookie: await login() }, redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${origin}/admin/storages?dropbox=error`);
  });
});
