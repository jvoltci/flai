import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` matches GitHub Pages deploy at /flai/. Override with VITE_BASE for other hosts.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/flai/',
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
