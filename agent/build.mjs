// Bundles the agent into dist/cli.js for npm: one plain JavaScript file with
// no dependencies, since Node won't strip types from a package in
// node_modules, and one file starts fastest for a hook that runs after
// every edit. `npm run build -w @fiada/agent`; npm publish runs it first.

import { build } from 'esbuild';

await build({
  entryPoints: [new URL('src/cli.ts', import.meta.url).pathname],
  outfile: new URL('dist/cli.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.19',
  // Every import is Node's own or ours; nothing is left to install.
  packages: 'bundle',
  legalComments: 'none',
  logLevel: 'info',
});
