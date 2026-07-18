import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  clearShareAuthorizationCookie,
  createShareAuthorization,
  hasShareAuthorization,
  shareAuthorizationCookie,
} from '../../src/worker/share-auth';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('share password authorization', () => {
  it('issues an HttpOnly token-scoped cookie and accepts it for the same share', async () => {
    const expiresAt = 2_000_000_000;
    const authorization = await createShareAuthorization(workerEnv(), 'share-a', expiresAt);
    const request = new Request('https://ilist.example/s/public-token');
    const header = await shareAuthorizationCookie(request, 'public-token', authorization, expiresAt, 1_900_000_000);

    expect(header).toContain('Path=/s/public-token');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    const cookie = header.split(';')[0];
    await expect(hasShareAuthorization(workerEnv(), new Request(request, { headers: { cookie } }), 'share-a', 'public-token', 1_900_000_000)).resolves.toBe(true);
  });

  it('rejects expired, wrong-share, wrong-token, and tampered authorization', async () => {
    const authorization = await createShareAuthorization(workerEnv(), 'share-a', 2_000_000_000);
    const header = await shareAuthorizationCookie(
      new Request('https://ilist.example/s/public-token'),
      'public-token',
      authorization,
      2_000_000_000,
      1_900_000_000,
    );
    const cookie = header.split(';')[0];

    await expect(hasShareAuthorization(workerEnv(), new Request('https://ilist.example/s/public-token', { headers: { cookie } }), 'share-a', 'public-token', 2_000_000_001)).resolves.toBe(false);
    await expect(hasShareAuthorization(workerEnv(), new Request('https://ilist.example/s/public-token', { headers: { cookie } }), 'share-b', 'public-token', 1_900_000_000)).resolves.toBe(false);
    await expect(hasShareAuthorization(workerEnv(), new Request('https://ilist.example/s/other-token', { headers: { cookie } }), 'share-a', 'other-token', 1_900_000_000)).resolves.toBe(false);

    const [name, value] = cookie.split('=');
    const tampered = `${name}=${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
    await expect(hasShareAuthorization(workerEnv(), new Request('https://ilist.example/s/public-token', { headers: { cookie: tampered } }), 'share-a', 'public-token', 1_900_000_000)).resolves.toBe(false);
  });

  it('uses separate cookie names per token and clears the matching path', async () => {
    const request = new Request('http://localhost:8787/s/token-a');
    const authorization = await createShareAuthorization(workerEnv(), 'share-a', 2_000_000_000);
    const first = await shareAuthorizationCookie(request, 'token-a', authorization, 2_000_000_000, 1_900_000_000);
    const second = await shareAuthorizationCookie(request, 'token-b', authorization, 2_000_000_000, 1_900_000_000);
    const cleared = await clearShareAuthorizationCookie(request, 'token-a');

    expect(first.split('=')[0]).not.toBe(second.split('=')[0]);
    expect(first).not.toContain('Secure');
    expect(cleared).toContain(`${first.split('=')[0]}=`);
    expect(cleared).toContain('Path=/s/token-a');
    expect(cleared).toContain('Max-Age=0');
  });
});
