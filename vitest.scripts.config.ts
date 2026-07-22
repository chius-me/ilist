import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/scripts/**/*.test.ts'],
    environment: 'node',
  },
});
