// @vitest-environment node

import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readPasswordInput } from '../../scripts/lib/password-input.mjs';

const script = fileURLToPath(new URL('../../scripts/hash-password.mjs', import.meta.url));

function run(args: string[] = [], input?: string) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input });
}

describe('password hash CLI', () => {
  it('rejects password argv without exposing it', () => {
    const secret = 'argv-secret-password';
    const result = run([secret]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('standard input');
    expect(result.stderr).not.toContain(secret);
  });

  it('accepts deliberate piped stdin and emits only the final hash to stdout', () => {
    const secret = 'piped-secret-password';
    const result = run([], `${secret}\n`);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^pbkdf2-sha256:600000:[0-9a-f]{32}:[0-9a-f]{64}\n$/);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).toBe('');
  });

  it('rejects overlong piped input without hash or secret disclosure', () => {
    const secret = '密'.repeat(86);
    const result = run([], `${secret}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('256 UTF-8 bytes');
    expect(result.stderr).not.toContain(secret);
  });

  it('routes TTY input through a raw, non-echoing prompt and restores terminal mode', async () => {
    class FakeInput extends EventEmitter {
      isTTY = true;
      setRawMode = vi.fn();
      setEncoding = vi.fn();
      resume = vi.fn();
      pause = vi.fn();
    }
    const input = new FakeInput();
    const writes: string[] = [];
    const errorOutput = { write: vi.fn((value: string) => { writes.push(value); return true; }) };
    const password = readPasswordInput(input, errorOutput);

    input.emit('data', 'hidden-password');
    input.emit('data', '\r');

    await expect(password).resolves.toBe('hidden-password');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.setEncoding).toHaveBeenCalledWith('utf8');
    expect(writes.join('')).toBe('Admin password: \n');
    expect(writes.join('')).not.toContain('hidden-password');
  });
});
