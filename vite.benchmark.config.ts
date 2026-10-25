// Adapted from ../hono-standard/vite.config.ts: same-origin Hono + React + Tailwind.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import devServer from '@hono/vite-dev-server';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss(), devServer({
    entry: resolve('packages/atlas/src/app.ts'),
    exclude: [/^\/(?!api(?:\/|$)).*/], injectClientScript: false,
  })],
  optimizeDeps: {include: ['@openuidev/react-lang']},
  server: {host: '127.0.0.1', port: 4317, strictPort: true, cors: false},
  build: {outDir: '../dist-web', emptyOutDir: true},
});
