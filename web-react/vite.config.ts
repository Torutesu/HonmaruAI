import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  build: {
    // The chunk warning is about a single-page app whose whole code is one
    // route; splitting it would add a request and save nothing.
    chunkSizeWarningLimit: 600,
  },
})
