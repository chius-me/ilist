import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword, verifyPasswordDetailed } from '../../src/worker/auth';

const LEGACY_TEST_PASSWORD_HASH =
  'pbkdf2:100000:59f4c454ba32d9dd29cfb537108c4d0b:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7';

describe('password hashing policy', () => {
  it('generates and verifies only the current versioned format', async () => {
    const stored = await hashPassword('test-password');
    const second = await hashPassword('test-password');

    expect(stored).toMatch(/^pbkdf2-sha256:600000:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(second.split(':')[2]).not.toBe(stored.split(':')[2]);
    await expect(verifyPasswordDetailed('test-password', stored)).resolves.toEqual({
      valid: true,
      needsUpgrade: false,
    });
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });

  it('accepts the legacy format for one release and marks it for upgrade', async () => {
    await expect(verifyPasswordDetailed('test-password', LEGACY_TEST_PASSWORD_HASH)).resolves.toEqual({
      valid: true,
      needsUpgrade: true,
    });
    await expect(verifyPassword('test-password', LEGACY_TEST_PASSWORD_HASH)).resolves.toBe(true);
  });

  it.each([
    '',
    'pbkdf2:99999:59f4c454ba32d9dd29cfb537108c4d0b:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7',
    'pbkdf2:100000:not-hex:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7',
    'pbkdf2:100000:59f4c454ba32d9dd29cfb537108c4d0b:odd',
    'pbkdf2-sha256:599999:59f4c454ba32d9dd29cfb537108c4d0b:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7',
    'argon2id:600000:59f4c454ba32d9dd29cfb537108c4d0b:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7',
  ])('fails closed for an invalid stored hash: %s', async (storedHash) => {
    await expect(verifyPasswordDetailed('test-password', storedHash)).resolves.toEqual({
      valid: false,
      needsUpgrade: false,
    });
  });

  it('rejects passwords over 256 UTF-8 bytes before deriveBits', async () => {
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits');
    const oversized = '密'.repeat(86);

    await expect(verifyPasswordDetailed(oversized, LEGACY_TEST_PASSWORD_HASH)).resolves.toEqual({
      valid: false,
      needsUpgrade: false,
    });
    await expect(hashPassword(oversized)).rejects.toThrow(RangeError);
    expect(deriveBits).not.toHaveBeenCalled();
  });
});
