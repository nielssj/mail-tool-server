import { defineConfig } from 'vitest/config';

// Integration tests spin up a real IMAP server (GreenMail) via testcontainers.
// They live only here, isolated from the default unit suite, and get longer
// timeouts to accommodate container startup.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
