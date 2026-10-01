// Live evals (they call real models and cost money): only via `npm run eval:*`, never `npm test`.
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, '../src/shared') }
  },
  test: {
    root: resolve(__dirname, '..'),
    environment: 'node',
    include: ['eval/**/*.eval.ts']
  }
})
