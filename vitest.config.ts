import { resolve } from 'path'
import { configDefaults, defineConfig } from 'vitest/config'

// `npm run test:live` overrides the exclude so test/live/** only runs on demand.
const live = process.env.npm_lifecycle_event === 'test:live'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: live ? ['test/live/**/*.test.ts'] : ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: live ? configDefaults.exclude : [...configDefaults.exclude, 'test/live/**']
  }
})
