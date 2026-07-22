import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/ui/**/*.test.ts', 'tests/ui/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./tests/ui/setup.ts'],
    passWithNoTests: true,
  },
});
