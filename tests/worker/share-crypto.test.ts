import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createShareToken, openShareItem, sealShareItem } from '../../src/worker/share-crypto';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('share cryptography', () => {
  it('creates opaque random tokens with a separate SHA-256 hash', async () => {
    const first = createShareToken();
    const second = createShareToken();

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(await first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await first.tokenHash).not.toBe(first.token);
  });

  it('seals provider item IDs with randomized share-bound handles', async () => {
    const first = await sealShareItem(workerEnv(), 'share-a', 'provider-item-42');
    const second = await sealShareItem(workerEnv(), 'share-a', 'provider-item-42');

    expect(first).not.toBe(second);
    expect(first).not.toContain('provider-item-42');
    await expect(openShareItem(workerEnv(), 'share-a', first)).resolves.toBe('provider-item-42');
    await expect(openShareItem(workerEnv(), 'share-b', first)).rejects.toMatchObject({
      status: 400,
      code: 'SHARE_ITEM_INVALID',
    });
  });

  it('rejects malformed and tampered handles without exposing cryptographic details', async () => {
    const handle = await sealShareItem(workerEnv(), 'share-a', 'provider-item-42');
    const tampered = `${handle.slice(0, -1)}${handle.endsWith('A') ? 'B' : 'A'}`;

    await expect(openShareItem(workerEnv(), 'share-a', tampered)).rejects.toMatchObject({
      status: 400,
      code: 'SHARE_ITEM_INVALID',
      message: 'Shared item is invalid',
    });
    await expect(openShareItem(workerEnv(), 'share-a', 'not-a-handle')).rejects.toMatchObject({
      code: 'SHARE_ITEM_INVALID',
    });
  });
});
