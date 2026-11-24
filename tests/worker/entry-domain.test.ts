import { describe, expect, it } from 'vitest';
import { matchesNameFilter, validateEntryName } from '../../src/worker/entry-domain';

describe('entry domain', () => {
  it.each(['', '   ', '.', '..', 'a/b', 'a\\b', 'bad\u0000name', 'del\u007fname', 'a'.repeat(256)])(
    'rejects invalid name %j',
    (name) => {
      expect(() => validateEntryName(name)).toThrow();
    },
  );

  it('accepts valid unicode and boundary-length entry names', () => {
    expect(validateEntryName('项目资料 2026.txt')).toBe('项目资料 2026.txt');
    expect(validateEntryName('a'.repeat(255))).toBe('a'.repeat(255));
  });

  it('matches names case-insensitively and ignores empty queries', () => {
    expect(matchesNameFilter('Reports', null)).toBe(true);
    expect(matchesNameFilter('Reports', '  ')).toBe(true);
    expect(matchesNameFilter('Reports', 'PORT')).toBe(true);
    expect(matchesNameFilter('Reports', 'xyz')).toBe(false);
  });
});
