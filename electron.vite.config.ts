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
          assistant: resolve('src/renderer/assistant.html'),
          screen: resolve('src/renderer/screen.html'),
          panel: resolve('src/renderer/panel.html'),
          a11y: resolve('src/renderer/a11y.html'),
          face: resolve('src/renderer/face.html'),
          recorder: resolve('src/renderer/recorder.html')
        }
      }
    }
  }
})
