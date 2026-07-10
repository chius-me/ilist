import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { stdin, stdout, stderr, exit } from 'node:process';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: stdin, output: stdout });

const password = process.argv[2] || await rl.question('Admin password: ');
rl.close();

if (!password || password.length < 8) {
  stderr.write('Password must be at least 8 characters.\n');
  exit(1);
}

const iterations = 100000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');

stdout.write(`pbkdf2:${iterations}:${salt.toString('hex')}:${hash.toString('hex')}\n`);
