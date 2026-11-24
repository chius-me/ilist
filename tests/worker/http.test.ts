import { describe, expect, it, vi } from 'vitest';
import { fail, HttpError, requireSameOrigin } from '../../src/worker/http';
import { fetchWithRetry } from '../../src/worker/shared/http-client';

describe('HTTP errors', () => {
  it('serializes a stable error code and details', async () => {
    const response = fail(409, 'ENTRY_NAME_CONFLICT', 'Name already exists', { name: 'readme.md' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'ENTRY_NAME_CONFLICT',
        message: 'Name already exists',
        details: { name: 'readme.md' },
      },
    });
  });

  it('stores status, code, message, and details on HttpError', () => {
    const error = new HttpError(400, 'INVALID_ENTRY_NAME', 'Invalid name', { reason: 'slash' });
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_ENTRY_NAME',
      message: 'Invalid name',
      details: { reason: 'slash' },
    });
  });

  it('rejects a cross-origin mutation', () => {
    const request = new Request('https://ilist.example/api/admin/folders', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    expect(() => requireSameOrigin(request)).toThrowError(HttpError);
  });

  it('guards 502/504 retries to idempotent or explicitly flagged requests', async () => {
    const postFetcher = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const postResponse = await fetchWithRetry(postFetcher, 'https://upstream.example/items', { method: 'POST', body: '{}' });
    expect(postResponse.status).toBe(502);
    expect(postFetcher).toHaveBeenCalledOnce();

    const idempotentPostFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const rpcResponse = await fetchWithRetry(idempotentPostFetcher, 'https://upstream.example/rpc', {
      method: 'POST',
      body: '{}',
      idempotent: true,
    });
    expect(rpcResponse.status).toBe(200);
    expect(idempotentPostFetcher).toHaveBeenCalledTimes(2);
  });
});
