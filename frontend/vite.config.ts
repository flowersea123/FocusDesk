import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    proxy: {
      '/api': { target: process.env.FOCUSDESK_DEV_BACKEND_URL || 'http://127.0.0.1:8787', changeOrigin: false },
      '/connect': { target: process.env.FOCUSDESK_DEV_BACKEND_URL || 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    restoreMocks: true,
  },
});
