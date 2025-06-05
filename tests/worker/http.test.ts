import { describe, expect, it } from 'vitest';
import { fail, HttpError, requireSameOrigin } from '../../src/worker/http';

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
});
