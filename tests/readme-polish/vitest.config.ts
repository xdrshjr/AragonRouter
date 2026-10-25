import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Test config for the `readme-polish` work package.
 *
 * The repository-level `vitest.config.ts` only includes the unit-test glob, and this work
 * package owns documentation only, so the README contract suite needs its own config:
 *
 *   npx vitest run --config tests/readme-polish/vitest.config.ts
 *
 * Everything here is static analysis of README.md plus the artefacts it describes
 * (`scripts/*.ps1`, `vitest.config.ts`, `tests/*\/vitest.config.ts`, `src/lib/*`,
 * `next.config.ts`, `src/app/icon.svg`) - no ports, no database, no network.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    environment: 'node',
    // Only this work package's own suite; the root config keeps the unit glob untouched.
    include: ['tests/readme-polish/**/*.test.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    reporters: ['default'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
