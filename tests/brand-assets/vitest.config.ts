import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Test config for the `brand-assets` work package.
 *
 * The repository-level `vitest.config.ts` only includes `tests/unit/**` and this work
 * package may not modify it, so the brand suite gets its own config:
 *
 *   npx vitest run --config tests/brand-assets/vitest.config.ts
 *
 * Everything here is plain TypeScript:
 *  - the two SVG assets are parsed with a small well-formedness checker and compared
 *    against the C10 token palette in `src/app/globals.css`;
 *  - the `BrandMark` component is imported and rendered with `react-dom/server`
 *    (`react-dom` is already a dependency - no jsdom, no testing-library, no new
 *    dependency), so the assertions are about the markup a browser actually receives;
 *  - the integration points (`Sidebar`, `Topbar`) are rendered the same way, and the
 *    `next build` artefacts under `.next/` are cross-checked when a build is present.
 *
 * The `automatic` JSX runtime is needed to import the `.tsx` sources from a `.ts`
 * test file; the root tsconfig keeps `jsx: preserve` for Next.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    // `.ts` for the asset/geometry analysis, `.tsx` for the suites that render the
    // component and its integration points through `react-dom/server`.
    include: ['tests/brand-assets/**/*.test.ts', 'tests/brand-assets/**/*.test.tsx'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    reporters: ['default'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
