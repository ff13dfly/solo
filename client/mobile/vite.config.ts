import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 9500,
  },
  // Use root path for local dev, /Solo·AI/mobile/ for production (GitHub Pages)
  base: mode === 'production' ? '/Solo·AI/mobile/' : '/',
}))
