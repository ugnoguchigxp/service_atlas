import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite', schema: './packages/atlas/src/schema.ts',
  out: './packages/atlas/migrations',
  dbCredentials: {url: process.env.ATLAS_DB_PATH ?? './data/atlas.sqlite'},
});
