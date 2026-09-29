// Runs the `fiada` command (src/cli.ts). The published package has no src/
// and runs the bundle in dist/, which needs nothing but Node. A checkout runs
// the TypeScript: Node 22.18+ strips types natively, which starts in about a
// tenth of a second; older Node goes through tsx. Hooks run after every edit
// an agent makes, so startup time matters.

import { existsSync } from 'node:fs';

/** `command` is the subcommand a bin stands for; without one, the first argument names it. */
export async function run(command) {
  const src = new URL('../src/cli.ts', import.meta.url);
  let entry = new URL('../dist/cli.js', import.meta.url);
  if (existsSync(src)) {
    entry = src;
    if (!process.features.typescript) {
      const { register } = await import('tsx/esm/api');
      register();
    }
  }
  const { cli } = await import(entry.href);
  await cli(command);
}
