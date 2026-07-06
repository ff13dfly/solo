import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwind()],
  server: {
    port: 9200,
  },
  // Use root path for local dev, /Solo·AI/system/ for production (GitHub Pages)
  base: mode === 'production' ? '/Solo·AI/system/' : '/',
}))
