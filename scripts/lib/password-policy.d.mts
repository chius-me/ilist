export const PBKDF2_SHA256_SCHEME: 'pbkdf2-sha256';
export const PBKDF2_SHA256_ITERATIONS: 600000;
export const LEGACY_PBKDF2_SCHEME: 'pbkdf2';
export const LEGACY_PBKDF2_MIN_ITERATIONS: 100000;
export const PBKDF2_SHA256_MAX_ITERATIONS: 600000;
export const PASSWORD_MAX_UTF8_BYTES: 256;
export const PASSWORD_SALT_BYTES: 16;
export const PASSWORD_HASH_BYTES: 32;

export interface ParsedPasswordHash {
  scheme: 'pbkdf2-sha256' | 'pbkdf2';
  iterations: number;
  saltHex: string;
  hashHex: string;
  needsUpgrade: boolean;
}

export function passwordUtf8Length(password: string): number;
export function passwordFitsPolicy(password: unknown): password is string;
export function parsePasswordHash(storedHash: unknown): ParsedPasswordHash | null;
export function formatPasswordHash(saltHex: string, hashHex: string): string;
