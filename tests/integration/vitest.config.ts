import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Test config for the ops-scripts work package.
 *
 * The repository-level `vitest.config.ts` only includes `tests/unit/**` (owned by
 * the gateway package) and this work package may not modify it, so the integration
 * suites are executed with their own config:
 *
 *   npx vitest run --config tests/integration/vitest.config.ts
 *
 * What runs here crosses module boundaries on purpose:
 *  - `stub-upstream.test.ts`         the stub upstream that `scripts/test-api.ps1`
 *                                    drives, checked against the constants the real
 *                                    relay uses (`@/lib/upstream`);
 *  - `gateway-stub.integration.test.ts`  real Next route handlers relaying into the
 *                                    real stub over real loopback sockets (C2/C5/C6/
 *                                    C7/C8/C9 exercised end to end, offline);
 *  - `scripts-contract.test.ts`      the PowerShell scripts, `.gitignore`,
 *                                    `.env.example` and `README.md` against the
 *                                    acceptance criteria and the shared contracts.
 *
 * The environment is plain Node: no jsdom, no network egress (127.0.0.1 only),
 * `DATABASE_PATH=:memory:` so no database file is ever written.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    reporters: ['default'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Files must run one at a time. `stub-upstream` and `gateway-stub` are independent (own
    // ephemeral ports, DATABASE_PATH=:memory:), but the `scripts-*` suites drive the *real*
    // repository root: one dev server per repo, the shared named mutex, the shared
    // .dev-server.pid / .dev-server.port records, and the 3000-3049 orphan scan stop-dev.ps1
    // performs. Running two of those files at once lets one file's stop/scan kill or unrecord the
    // other file's live server; that is how the -AbortAfterStep case failed once with the finally's
    // "收尾停机完成" line missing (a sibling had rewritten the records in the meantime). Sequential
    // execution costs a few minutes and makes the suite deterministic.
    fileParallelism: false,
  },
});
