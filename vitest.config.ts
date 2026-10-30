import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'entrypoints/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      // The pure logic: rules, classifier, playlists, client, storage, settings and the services around them. The
      // generated API types and the end-to-end tests are not counted.
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/*.test.ts', 'src/lib/api/schema.d.ts', 'src/lib/**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { statements: 88, branches: 80, functions: 90, lines: 90 },
    },
  },
});
