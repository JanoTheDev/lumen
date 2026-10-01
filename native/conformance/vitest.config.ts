import { defineConfig } from 'vitest/config'

// Run from the repo root: npx vitest run --root native/conformance
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One desktop: input/UIA tests must not race each other.
    fileParallelism: false
  }
})
