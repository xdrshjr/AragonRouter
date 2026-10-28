import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Test config for the console UI work package.
 *
 * The repository-level `vitest.config.ts` only includes `tests/unit/**` (owned by
 * the gateway package), and this work package may not modify it. Running
 * `npx vitest run --config tests/ui/vitest.config.ts` therefore executes the
 * console suites on their own.
 *
 * Everything under test here is plain TypeScript (query builders, formatters, SVG
 * geometry, the typed API client and the pure React-adjacent helpers), so the
 * node environment is all that is needed - no jsdom, no extra dependency.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  /**
   * The UI kit is JSX. Tests render client components to static markup with
   * `react-dom/server` (no DOM, no extra dependency), which needs the automatic
   * JSX runtime - the root tsconfig keeps `jsx: preserve` for Next.
   */
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: [
      'tests/ui/**/*.test.ts',
      'tests/ui/**/*.test.tsx',
      /**
       * `tests/users-admin-ui/**` is the same console suite, registered here for the
       * user-management work package. One glob list (rather than a second config)
       * keeps a single command for every console assertion, and a file can move
       * between the two directories without rewriting its imports.
       */
      'tests/users-admin-ui/**/*.test.ts',
      'tests/users-admin-ui/**/*.test.tsx',
    ],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    reporters: ['default'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
