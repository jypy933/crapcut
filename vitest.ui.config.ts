import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['test/ui/**/*.ui.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ['verbose']
  }
})
