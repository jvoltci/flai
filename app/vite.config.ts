import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 5174, not 5173: the web app runs on 5173 and both are often open at once.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  // Tauri serves the built files from disk, so assets must be relative.
  base: './',
  build: { target: 'es2022', sourcemap: true },
});
