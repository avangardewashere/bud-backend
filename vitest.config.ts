import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // argon2 is deliberately slow; the default 5s is tight for hashing tests.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['**/*.spec.ts', 'src/main.ts', 'dist/**', 'prisma/**'],
    },
  },
  plugins: [
    // esbuild (Vitest's default TS transform) cannot emit decorator metadata,
    // which Nest's DI reads at runtime. SWC can.
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
