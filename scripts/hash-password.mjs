import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { stdin, stdout, stderr, exit } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  formatPasswordHash,
  passwordFitsPolicy,
  PBKDF2_SHA256_ITERATIONS,
  PASSWORD_HASH_BYTES,
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_SALT_BYTES,
} from './lib/password-policy.mjs';

const rl = createInterface({ input: stdin, output: stderr });

const password = process.argv[2] || await rl.question('Admin password: ');
rl.close();

if (!password || password.length < 8 || !passwordFitsPolicy(password)) {
  stderr.write(`Password must be at least 8 characters and at most ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes.\n`);
  exit(1);
}

const salt = randomBytes(PASSWORD_SALT_BYTES);
const hash = pbkdf2Sync(password, salt, PBKDF2_SHA256_ITERATIONS, PASSWORD_HASH_BYTES, 'sha256');

stdout.write(`${formatPasswordHash(salt.toString('hex'), hash.toString('hex'))}\n`);
