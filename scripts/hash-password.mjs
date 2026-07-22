import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { stdin, stdout, stderr, exit } from 'node:process';
import { readPasswordInput } from './lib/password-input.mjs';
import {
  formatPasswordHash,
  passwordFitsPolicy,
  PBKDF2_SHA256_ITERATIONS,
  PASSWORD_HASH_BYTES,
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_SALT_BYTES,
} from './lib/password-policy.mjs';

if (process.argv.length > 2) {
  stderr.write('Password arguments are not accepted; use the interactive prompt or standard input.\n');
  exit(1);
}

let password;
try {
  password = await readPasswordInput(stdin, stderr);
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : 'Unable to read password input.'}\n`);
  exit(1);
}

if (!password || password.length < 8 || !passwordFitsPolicy(password)) {
  stderr.write(`Password must be at least 8 characters and at most ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes.\n`);
  exit(1);
}

const salt = randomBytes(PASSWORD_SALT_BYTES);
const hash = pbkdf2Sync(password, salt, PBKDF2_SHA256_ITERATIONS, PASSWORD_HASH_BYTES, 'sha256');

stdout.write(`${formatPasswordHash(salt.toString('hex'), hash.toString('hex'))}\n`);
