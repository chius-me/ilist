import { describe, expect, it, vi } from 'vitest';
import { authenticatePikPak, refreshPikPakToken } from '../../src/worker/drivers/pikpak/auth';

describe('PikPak authentication', () => {
  it('exchanges a password for tokens without returning the password', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ captcha_token: 'captcha', expires_in: 300 }))
      .mockResolvedValueOnce(Response.json({
        token_type: 'Bearer', access_token: 'access', refresh_token: 'refresh', expires_in: 3600, sub: 'user-id',
      }));
    const result = await authenticatePikPak('user@example.com', 'temporary-password', 'device-id', fetcher);
    expect(result).toMatchObject({ auth: { accessToken: 'access', refreshToken: 'refresh' }, deviceId: 'device-id' });
    expect(JSON.stringify(result)).not.toContain('temporary-password');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains refresh tokens when PikPak rotates only the access token', async () => {
    const fetcher = vi.fn(async () => Response.json({ token_type: 'Bearer', access_token: 'next-access', expires_in: 3600 }));
    await expect(refreshPikPakToken('current-refresh', 'device-id', fetcher)).resolves.toMatchObject({
      accessToken: 'next-access', refreshToken: 'current-refresh',
    });
  });

  it('returns an actionable verification error without exposing upstream details', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'captcha_required', error_description: 'private detail' }, { status: 400 }));
    const error = await authenticatePikPak('user', 'password', 'device-id', fetcher).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'PIKPAK_VERIFICATION_REQUIRED' });
    expect(String(error)).not.toContain('private detail');
  });
});
