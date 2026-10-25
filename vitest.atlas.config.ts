import { defineConfig } from 'vitest/config';
export default defineConfig({test: {include: ['packages/atlas/tests/**/*.vitest.ts', 'web/src/**/*.test.tsx']}});
