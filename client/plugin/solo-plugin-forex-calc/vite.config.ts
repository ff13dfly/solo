import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
    plugins: [react()],
    build: {
        lib: {
            entry: resolve(__dirname, 'ForexCalc.tsx'),
            name: 'ForexCalc',
            fileName: () => `index.js`,
            formats: ['es']
        },
        rollupOptions: {
            // Internalize these as they will be provided by the host
            external: ['react', 'react-dom', 'framer-motion', 'lucide-react', 'react/jsx-runtime'],
            output: {
                globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM'
                }
            }
        }
    }
});
