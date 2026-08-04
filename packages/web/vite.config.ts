import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.REGARDEDTRADER_SERVER_URL || 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/calendar': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
