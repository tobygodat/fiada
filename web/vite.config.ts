import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const indexer = `http://127.0.0.1:${process.env.STRATA_INDEXER_PORT ?? 4178}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    proxy: { '/api': indexer },
  },
  preview: {
    port: 5178,
    proxy: { '/api': indexer },
  },
});
