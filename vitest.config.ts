import {defineConfig} from 'vitest/config';

// One runner for every package/app. The interface of each module is the
// test surface: unit tests live next to the source they exercise, and
// integration tests spin real loopback swarms instead of mock networks.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
