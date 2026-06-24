export const PBKDF2_SHA256_SCHEME = 'pbkdf2-sha256';
export const PBKDF2_SHA256_ITERATIONS = 600_000;
export const LEGACY_PBKDF2_SCHEME = 'pbkdf2';
export const LEGACY_PBKDF2_MIN_ITERATIONS = 100_000;
export const PASSWORD_MAX_UTF8_BYTES = 256;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_HASH_BYTES = 32;

const HEX = /^[0-9a-f]+$/i;
const DECIMAL = /^[0-9]+$/;

export function passwordUtf8Length(password) {
  return new TextEncoder().encode(password).byteLength;
}

export function passwordFitsPolicy(password) {
  return typeof password === 'string' && passwordUtf8Length(password) <= PASSWORD_MAX_UTF8_BYTES;
}

export function parsePasswordHash(storedHash) {
  if (typeof storedHash !== 'string') return null;
  const parts = storedHash.split(':');
  if (parts.length !== 4) return null;

  const [scheme, iterationsText, saltHex, hashHex] = parts;
  if (!DECIMAL.test(iterationsText)) return null;
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations)) return null;

  const current = scheme === PBKDF2_SHA256_SCHEME && iterations === PBKDF2_SHA256_ITERATIONS;
  const legacy = scheme === LEGACY_PBKDF2_SCHEME && iterations >= LEGACY_PBKDF2_MIN_ITERATIONS;
  if (!current && !legacy) return null;
  if (saltHex.length !== PASSWORD_SALT_BYTES * 2 || !HEX.test(saltHex)) return null;
  if (hashHex.length !== PASSWORD_HASH_BYTES * 2 || !HEX.test(hashHex)) return null;

  return {
    scheme,
    iterations,
    saltHex: saltHex.toLowerCase(),
    hashHex: hashHex.toLowerCase(),
    needsUpgrade: legacy,
  };
}

export function formatPasswordHash(saltHex, hashHex) {
  if (saltHex.length !== PASSWORD_SALT_BYTES * 2 || !HEX.test(saltHex)) {
    throw new TypeError('Password salt must be a 16-byte hexadecimal value');
  }
  if (hashHex.length !== PASSWORD_HASH_BYTES * 2 || !HEX.test(hashHex)) {
    throw new TypeError('Password hash must be a 32-byte hexadecimal value');
  }
  return `${PBKDF2_SHA256_SCHEME}:${PBKDF2_SHA256_ITERATIONS}:${saltHex.toLowerCase()}:${hashHex.toLowerCase()}`;
}
