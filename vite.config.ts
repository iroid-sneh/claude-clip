import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath, URL } from 'node:url'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      // Offscreen document is not referenced by the manifest, so declare it
      // explicitly as a build entry.
      input: {
        offscreen: fileURLToPath(new URL('./offscreen.html', import.meta.url)),
        permission: fileURLToPath(new URL('./permission.html', import.meta.url)),
      },
    },
  },
})
