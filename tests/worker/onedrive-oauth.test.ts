import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createMount } from '../../src/worker/mounts';
import { getCredentials } from '../../src/worker/credentials';
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

async function createOneDriveMount(): Promise<string> {
  return (await createMount(workerEnv().DB, {
    name: `OneDrive ${crypto.randomUUID()}`,
    mountPath: `/onedrive-${crypto.randomUUID()}`,
    driverType: 'onedrive',
    provider: 'microsoft-onedrive-personal',
    config: {},
  })).id;
}

async function start(mountId: string): Promise<Response> {
  const cookie = await login();
  return SELF.fetch(`${origin}/api/admin/oauth/onedrive/start?mountId=${encodeURIComponent(mountId)}`, {
    headers: { cookie },
    redirect: 'manual',
  });
}

describe('OneDrive OAuth routes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a consumers PKCE authorization URL with exact scopes and a fixed callback origin', async () => {
    const mountId = await createOneDriveMount();
    const response = await start(mountId);

    expect(response.status).toBe(302);
    const authorization = new URL(response.headers.get('location')!);
    expect(`${authorization.origin}${authorization.pathname}`).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    expect(authorization.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite');
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${origin}/api/admin/oauth/onedrive/callback`);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const state = authorization.searchParams.get('state')!;
    const row = await workerEnv().DB.prepare('SELECT state_hash, verifier_ciphertext FROM oauth_states WHERE mount_id = ?')
      .bind(mountId).first<{ state_hash: string; verifier_ciphertext: string }>();
    expect(row).not.toBeNull();
    expect(row!.state_hash).not.toBe(state);
    expect(row!.verifier_ciphertext).not.toContain(state);
  });

  it('consumes state once, encrypts tokens, and redirects to the configured public origin', async () => {
    const mountId = await createOneDriveMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const state = authorization.searchParams.get('state')!;
    const tokenFetch = vi.fn(async () => Response.json({
        token_type: 'Bearer', access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
        scope: 'offline_access User.Read Files.ReadWrite',
      }));
    vi.stubGlobal('fetch', tokenFetch);

    const cookie = await login();
    const callback = await SELF.fetch(`${origin}/api/admin/oauth/onedrive/callback?code=code-1&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/admin/storages?onedrive=connected`);
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({
      accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
    });
    const stored = await workerEnv().DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?')
      .bind(mountId).first<{ ciphertext: string }>();
    expect(stored!.ciphertext).not.toContain('refresh-token');

    const replay = await SELF.fetch(`${origin}/api/admin/oauth/onedrive/callback?code=code-2&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error: { code: string } }).error.code).toBe('OAUTH_STATE_INVALID');
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it('rejects expired state before contacting Microsoft', async () => {
    const mountId = await createOneDriveMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const state = authorization.searchParams.get('state')!;
    await workerEnv().DB.prepare('UPDATE oauth_states SET expires_at = 0 WHERE mount_id = ?').bind(mountId).run();
    const tokenFetch = vi.fn();
    vi.stubGlobal('fetch', tokenFetch);

    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/oauth/onedrive/callback?code=code&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('OAUTH_STATE_EXPIRED');
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('rejects callbacks served from an origin outside PUBLIC_ORIGIN', async () => {
    const mountId = await createOneDriveMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const cookie = await login();

    const response = await SELF.fetch(`https://ilist-workers.example/api/admin/oauth/onedrive/callback?code=code&state=${authorization.searchParams.get('state')}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('consumes denied authorization state and returns to storage settings with an error status', async () => {
    const mountId = await createOneDriveMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/oauth/onedrive/callback?error=access_denied&state=${authorization.searchParams.get('state')}`, {
      headers: { cookie }, redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${origin}/admin/storages?onedrive=error`);
    const remaining = await workerEnv().DB.prepare('SELECT state_hash FROM oauth_states WHERE mount_id = ?').bind(mountId).first();
    expect(remaining).toBeNull();
  });
});
