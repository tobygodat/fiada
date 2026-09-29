// The `fiada` command, and what every bin runs:
//   fiada setup [--write <dir>] [--url <indexer> --token <token>]   connect Claude Code to a map
//   fiada hook [command …]                                           the tool hook (reads a payload on stdin)
//   fiada mcp                                                        the stdio MCP server
// The published package bundles this into dist/cli.js; a checkout runs it from source.

import './env.ts';
import { runHook } from './hook.ts';
import { runMcp } from './mcp.ts';
import { PACKAGE, runSetup } from './setup.ts';

const USAGE = `fiada ${PACKAGE.version}: tells Fiada what a coding agent is doing.

  fiada setup --write . --url <indexer> --token <token>   connect Claude Code in this folder to your map
  fiada setup                                             print the configuration to add by hand
  fiada hook                                              the tool hook Claude Code, Cursor or Codex runs
  fiada mcp                                               the MCP server an agent is given

The map's "connect an agent" gives the setup command with your indexer and token filled in.`;

/** Runs a subcommand: `command`, or the first argument when none is given. */
export async function cli(command?: string, args = process.argv.slice(2)) {
  const [cmd, rest] = command ? [command, args] : [args[0], args.slice(1)];
  switch (cmd) {
    case 'setup':
      return runSetup(rest).catch((err) => {
        console.error((err as Error).message);
        process.exit(1);
      });
    case 'hook':
      return runHook(rest);
    case 'mcp':
      return runMcp();
    case '--version':
    case '-v':
      return console.log(PACKAGE.version);
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
  }
}
