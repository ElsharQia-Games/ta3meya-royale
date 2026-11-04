import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
      '/stats': 'http://127.0.0.1:3000',
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
  build: { outDir: 'dist', target: 'es2022' },
});
