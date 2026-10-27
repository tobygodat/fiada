import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const indexer = `http://127.0.0.1:${process.env.STRATA_INDEXER_PORT ?? process.env.FIADA_INDEXER_PORT ?? 4178}`;
// xfwd tells the indexer the address the browser used, so GitHub sign-in comes back here.
const api = { target: indexer, changeOrigin: true, xfwd: true };

// Cloudflare Web Analytics counts visits to the built site, without cookies. Only builds
// carry the beacon, so the dev server reports nothing. The token is public by design.
const analytics: Plugin = {
  name: 'cloudflare-web-analytics',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'script',
      attrs: { defer: true, src: 'https://static.cloudflareinsights.com/beacon.min.js', 'data-cf-beacon': '{"token": "97efc6c7283c446285a4256c4697e4ba"}' },
      injectTo: 'body',
    },
  ],
};

export default defineConfig({
  plugins: [react(), analytics],
  server: {
    port: 5178,
    proxy: { '/api': api },
  },
  preview: {
    port: 5178,
    proxy: { '/api': api },
  },
});
