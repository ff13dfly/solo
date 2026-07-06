import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import path from 'path';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@common': path.resolve(__dirname, '../../common'),
    },
  },
  server: {
    port: 9300,
  },
  // Use root path for local dev, /Solo·AI/operator/ for production (GitHub Pages)
  base: mode === 'production' ? '/Solo·AI/operator/' : '/',
}))
