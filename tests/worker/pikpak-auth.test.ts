import { describe, expect, it, vi } from 'vitest';
import { authenticatePikPak, PIKPAK_CLIENT_ID, refreshPikPakToken } from '../../src/worker/drivers/pikpak/auth';

describe('PikPak authentication', () => {
  it('exchanges a password for tokens without returning the password', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      token_type: 'Bearer', access_token: 'access', refresh_token: 'refresh', expires_in: 3600, sub: 'user-id',
    }));
    const result = await authenticatePikPak('user@example.com', 'temporary-password', fetcher);
    expect(result).toMatchObject({ auth: { accessToken: 'access', refreshToken: 'refresh' }, username: 'user@example.com' });
    expect(JSON.stringify(result)).not.toContain('temporary-password');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://user.mypikpak.net/v1/auth/signin');
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: PIKPAK_CLIENT_ID, username: 'user@example.com', password: 'temporary-password',
    });
  });

  it('retains refresh tokens when PikPak rotates only the access token', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ token_type: 'Bearer', access_token: 'next-access', expires_in: 3600 }));
    await expect(refreshPikPakToken('current-refresh', fetcher)).resolves.toMatchObject({
      accessToken: 'next-access', refreshToken: 'current-refresh',
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://user.mypikpak.net/v1/auth/token');
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: PIKPAK_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'current-refresh',
    });
  });

  it('returns an actionable verification error without exposing upstream details', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'captcha_required', error_description: 'private detail' }, { status: 400 }));
    const error = await authenticatePikPak('user', 'password', fetcher).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'PIKPAK_AUTH_FAILED', details: { upstreamReason: 'captcha_required' } });
    expect(String(error)).not.toContain('private detail');
  });
});
