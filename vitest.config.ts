import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Unit tests run in plain Node (no jsdom, no network, no real database file).
 * Database-backed tests point DATABASE_PATH at ':memory:' so nothing is ever
 * written to disk.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    reporters: ['default'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
