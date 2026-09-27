// npm run agent:setup [-- --write <project dir>]
//
// Prints the Claude Code configuration that connects an agent to Strata: the
// MCP server command and the hooks block, with this checkout's absolute
// paths. With --write it merges the hooks into <project>/.claude/settings.local.json
// (Claude Code's per-user, git-ignored settings) and registers the MCP server
// for that project with `claude mcp add`.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/', import.meta.url));
const q = (p: string) => (/[\s"'$]/.test(p) ? JSON.stringify(p) : p);
const HOOK = `node ${q(path.join(BIN, 'strata-hook.mjs'))}`;
const MCP = ['node', path.join(BIN, 'strata-mcp.mjs')];

/** Tools whose results can change files or the plan. Read-only tools are left out so they cost nothing. */
export const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|TodoWrite|TaskCreate|TaskUpdate';

type HookEntry = { matcher?: string; hooks: { type: 'command'; command: string; timeout?: number }[] };

export function hooksBlock(command = HOOK): Record<string, HookEntry[]> {
  const run = [{ type: 'command' as const, command, timeout: 10 }];
  return {
    SessionStart: [{ hooks: run }],
    UserPromptSubmit: [{ hooks: run }],
    PostToolUse: [{ matcher: MATCHER, hooks: run }],
    Stop: [{ hooks: run }],
    SessionEnd: [{ hooks: run }],
  };
}

/** Adds Strata's hooks to a settings object, replacing any earlier Strata entries and keeping everything else. */
export function mergeHooks(settings: Record<string, any>, block = hooksBlock()): Record<string, any> {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  for (const [event, entries] of Object.entries(block)) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !String(h.command ?? '').includes('strata-hook')) }))
      .filter((e) => e.hooks.length);
    hooks[event] = [...kept, ...entries];
  }
  return { ...settings, hooks };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--write');
  if (at < 0) {
    console.log(`Connect Claude Code to Strata

1. The MCP server (run in your project):

   claude mcp add strata -- ${MCP.map(q).join(' ')}

2. The hooks, in your project's .claude/settings.local.json (or .claude/settings.json to share them, or ~/.claude/settings.json for every project):

${JSON.stringify({ hooks: hooksBlock() }, null, 2).replace(/^/gm, '   ')}

Or let this script do both:  npm run agent:setup -- --write /path/to/your/project
`);
    return;
  }
  const dir = path.resolve(args[at + 1] ?? process.cwd());
  const file = path.join(dir, '.claude', 'settings.local.json');
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Couldn't read ${file}: ${(err as Error).message}`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(mergeHooks(settings), null, 2)}\n`);
  console.log(`Hooks written to ${file}`);
  try {
    await exec('claude', ['mcp', 'remove', 'strata'], { cwd: dir }).catch(() => undefined);
    await exec('claude', ['mcp', 'add', 'strata', '--', ...MCP], { cwd: dir });
    console.log(`MCP server "strata" added for ${dir}`);
  } catch {
    console.log(`Couldn't run \`claude mcp add\`; in ${dir}, run:\n  claude mcp add strata -- ${MCP.map(q).join(' ')}`);
  }
}

if (process.argv[1] && /strata-setup(\.mjs)?$|setup\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
