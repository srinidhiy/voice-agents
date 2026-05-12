import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/session': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
