// Bundles the agent into dist/cli.js for npm: one plain JavaScript file with
// no dependencies, since Node won't strip types from a package in
// node_modules, and one file starts fastest for a hook that runs after
// every edit. `npm run build -w @fiada/agent`; npm publish runs it first.

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  // Paths, not URL pathnames, which keep %20 for a space and misplace a Windows drive letter.
  entryPoints: [fileURLToPath(new URL('src/cli.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('dist/cli.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.19',
  // Every import is Node's own or ours; nothing is left to install.
  packages: 'bundle',
  legalComments: 'none',
  logLevel: 'info',
});
