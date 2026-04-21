import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    define: {
      'process.env.ANTHROPIC_API_KEY': JSON.stringify(process.env.ANTHROPIC_API_KEY)
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          highlight: resolve('src/renderer/highlight.html'),
          voicebar: resolve('src/renderer/voicebar.html'),
          answeroverlay: resolve('src/renderer/answeroverlay.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    }
  }
})
