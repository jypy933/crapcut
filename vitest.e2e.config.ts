import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 3 * 60 * 60 * 1000,
    hookTimeout: 60_000,
    reporters: ['verbose']
  }
})
