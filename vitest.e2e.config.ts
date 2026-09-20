import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite: runs against an API that is already listening, over real
 * HTTP, against a real Postgres and a real MinIO.
 *
 * Separate from the unit config because it has different preconditions — the
 * unit tests must pass with nothing running, and these need a booted stack.
 * They skip rather than fail when it is absent, so running them by accident is
 * harmless.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    setupFiles: ['./test/e2e/setup.ts'],
    // Real HTTP against a real database, and argon2 in the fixtures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One file at a time: these share a database, and a suite that races itself
    // is worse than a slow one.
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
