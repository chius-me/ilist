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
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function createGoogleMount(): Promise<string> {
  return (await createMount(workerEnv().DB, {
    name: `Google Drive ${crypto.randomUUID()}`,
    mountPath: `/google-${crypto.randomUUID()}`,
    driverType: 'google',
    provider: 'google',
    config: {},
  })).id;
}

async function start(mountId: string): Promise<Response> {
  const cookie = await login();
  return SELF.fetch(`${origin}/api/admin/oauth/google/start?mountId=${encodeURIComponent(mountId)}`, {
    headers: { cookie },
    redirect: 'manual',
  });
}

describe('Google Drive OAuth routes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds an offline PKCE authorization URL with the Drive scope and fixed callback origin', async () => {
    const mountId = await createGoogleMount();
    const response = await start(mountId);

    expect(response.status).toBe(302);
    const authorization = new URL(response.headers.get('location')!);
    expect(`${authorization.origin}${authorization.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive');
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${origin}/api/admin/oauth/google/callback`);
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    expect(authorization.searchParams.get('prompt')).toBe('consent');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const state = authorization.searchParams.get('state')!;
    const row = await workerEnv().DB.prepare('SELECT state_hash, verifier_ciphertext FROM oauth_states WHERE mount_id = ?')
      .bind(mountId).first<{ state_hash: string; verifier_ciphertext: string }>();
    expect(row).not.toBeNull();
    expect(row!.state_hash).not.toBe(state);
    expect(row!.verifier_ciphertext).not.toContain(state);
  });

  it('consumes state once, stores encrypted tokens, and redirects to storage settings', async () => {
    const mountId = await createGoogleMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const state = authorization.searchParams.get('state')!;
    const tokenFetch = vi.fn(async () => Response.json({
      token_type: 'Bearer', access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive',
    }));
    vi.stubGlobal('fetch', tokenFetch);

    const cookie = await login();
    const callback = await SELF.fetch(`${origin}/api/admin/oauth/google/callback?code=code-1&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/admin/storages?google=connected`);
    await expect(getCredentials(workerEnv(), mountId)).resolves.toMatchObject({
      accessToken: 'google-access', refreshToken: 'google-refresh', tokenType: 'Bearer',
    });
    const stored = await workerEnv().DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?')
      .bind(mountId).first<{ ciphertext: string }>();
    expect(stored!.ciphertext).not.toContain('google-refresh');

    const replay = await SELF.fetch(`${origin}/api/admin/oauth/google/callback?code=code-2&state=${encodeURIComponent(state)}`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error: { code: string } }).error.code).toBe('OAUTH_STATE_INVALID');
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it('consumes denied authorization state and returns a sanitized error status', async () => {
    const mountId = await createGoogleMount();
    const authorization = new URL((await start(mountId)).headers.get('location')!);
    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/oauth/google/callback?error=access_denied&state=${authorization.searchParams.get('state')}`, {
      headers: { cookie }, redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${origin}/admin/storages?google=error`);
    const remaining = await workerEnv().DB.prepare('SELECT state_hash FROM oauth_states WHERE mount_id = ?').bind(mountId).first();
    expect(remaining).toBeNull();
  });
});
