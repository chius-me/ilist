import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createShareToken, openShareItem, sealShareItem } from '../../src/worker/share-crypto';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function legacyV1Handle(shareId: string, itemId: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`ilist:share-item:v1:${workerEnv().SESSION_SECRET}`),
  );
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(shareId) },
    key,
    encoder.encode(JSON.stringify({ v: 1, itemId })),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
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

  it('seals root and provider item IDs with randomized share-bound v2 handles', async () => {
    const first = await sealShareItem(workerEnv(), 'share-a', 'provider-root-7', 'provider-item-42');
    const second = await sealShareItem(workerEnv(), 'share-a', 'provider-root-7', 'provider-item-42');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v2\./);
    expect(first).not.toContain('provider-root-7');
    expect(first).not.toContain('provider-item-42');
    await expect(openShareItem(workerEnv(), 'share-a', first)).resolves.toEqual({
      rootItemId: 'provider-root-7',
      itemId: 'provider-item-42',
    });
    await expect(openShareItem(workerEnv(), 'share-b', first)).rejects.toMatchObject({
      status: 400,
      code: 'SHARE_ITEM_INVALID',
    });
  });

  it('rejects malformed and tampered handles without exposing cryptographic details', async () => {
    const handle = await sealShareItem(workerEnv(), 'share-a', 'provider-root-7', 'provider-item-42');
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

  it('opens legacy v1 handles without inventing an embedded root', async () => {
    const handle = await legacyV1Handle('share-a', 'legacy-item');

    await expect(openShareItem(workerEnv(), 'share-a', handle)).resolves.toEqual({
      rootItemId: null,
      itemId: 'legacy-item',
    });
  });
});
