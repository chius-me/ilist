import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_USERNAME: 'admin',
          ADMIN_PASSWORD_HASH:
            'pbkdf2:100000:59f4c454ba32d9dd29cfb537108c4d0b:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7',
          CREDENTIAL_MASTER_KEY: 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=',
          SESSION_SECRET: 'test-session-secret-at-least-32-characters',
          SESSION_TTL_SECONDS: '3600',
        },
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    setupFiles: ['./tests/worker/setup.ts'],
  },
});
