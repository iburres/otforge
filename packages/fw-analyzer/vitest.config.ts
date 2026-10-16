/**
 * vitest.config.ts — Vitest configuration for the fw-analyzer package.
 *
 * fw-analyzer is a CommonJS Node.js package that shells out to Docker and
 * walks the filesystem, so tests run in a plain Node environment. Unit tests
 * inject a fake command runner and never touch Docker; the one end-to-end
 * test is opt-in via FW_E2E_IMAGE (see src/__tests__/unpack.test.ts).
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /** Pure Node.js environment — no jsdom, no browser globals. */
    environment: 'node',

    /** Only discover tests under src/ — never the compiled dist/ copies. */
    include: ['src/**/*.{test,spec}.{ts,js}'],

    /** Tests import describe/it/expect explicitly. */
    globals: false,

    /** Each test file gets its own module context. */
    isolate: true,

    /**
     * The opt-in end-to-end unpack runs a real unblob extraction in Docker,
     * which takes ~1–2 minutes on a laptop. Unit tests finish in milliseconds.
     */
    testTimeout: 300_000
  }
})
