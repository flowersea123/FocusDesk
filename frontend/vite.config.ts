import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const mailPort = Number(process.env.FOCUSDESK_TRIAL_PORT ?? 5184);
if (!Number.isInteger(mailPort) || mailPort < 1 || mailPort > 65535) throw new Error('试读页端口应为 1 至 65535。');

export default defineConfig({
  define: { 'import.meta.env.VITE_MAIL_PAGE_URL': JSON.stringify(`http://127.0.0.1:${mailPort}/`) },
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
