import { describe, expect, it } from 'vitest';
import {
  normalizeVirtualPath,
  storageKeyForEntry,
  validateEntryName,
} from '../../src/worker/entry-domain';

describe('entry domain', () => {
  it('decodes Chinese path segments independently', () => {
    expect(normalizeVirtualPath('/R2/%E9%A1%B9%E7%9B%AE/demo')).toEqual({
      path: '/R2/项目/demo',
      segments: ['R2', '项目', 'demo'],
    });
  });

  it.each(['', '.', '..', 'a/b', 'bad\u0000name'])('rejects invalid name %j', (name) => {
    expect(() => validateEntryName(name)).toThrow();
  });

  it('rejects reserved root names only at the root', () => {
    expect(() => validateEntryName('api', true)).toThrow();
    expect(validateEntryName('api', false)).toBe('api');
  });

  it('uses an immutable physical key', () => {
    expect(storageKeyForEntry('018f-entry')).toBe('blobs/018f-entry');
  });
});
