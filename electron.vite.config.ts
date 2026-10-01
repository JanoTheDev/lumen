import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          highlight: resolve('src/renderer/highlight.html'),
          answeroverlay: resolve('src/renderer/answeroverlay.html'),
          settings: resolve('src/renderer/settings.html'),
          status: resolve('src/renderer/status.html'),
          dwellring: resolve('src/renderer/dwellring.html'),
          assistant: resolve('src/renderer/assistant.html'),
          screen: resolve('src/renderer/screen.html'),
          panel: resolve('src/renderer/panel.html')
        }
      }
    }
  }
})
