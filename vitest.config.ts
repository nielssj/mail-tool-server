import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests require Docker and run via vitest.integration.config.ts;
    // keep the default unit suite free of any container/network dependency.
    exclude: [...configDefaults.exclude, 'test/integration/**']
  }
});
