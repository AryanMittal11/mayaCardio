import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mayacardio/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@mayacardio/processing': path.resolve(__dirname, 'packages/processing/src/index.ts'),
      '@mayacardio/device-storage': path.resolve(__dirname, 'packages/device-storage/src/index.ts'),
      '@mayacardio/mock-service': path.resolve(__dirname, 'packages/mock-service/src/index.ts'),
      '@mayacardio/collector': path.resolve(__dirname, 'packages/collector/src/index.ts'),
      '@mayacardio/cloud-api': path.resolve(__dirname, 'packages/cloud-api/src/index.ts'),
      '@mayacardio/state-machine': path.resolve(__dirname, 'packages/state-machine/src/index.ts'),
      '@mayacardio/sync': path.resolve(__dirname, 'packages/sync/src/index.ts'),
      '@mayacardio/cli': path.resolve(__dirname, 'packages/cli/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    testTimeout: 20000,
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
});
