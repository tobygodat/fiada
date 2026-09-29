// fiada setup [--write <project dir>] [--url <indexer> --token <agent token>]
// (npx @fiada/agent setup …, or npm run agent:setup -- … in a checkout)
//
// Prints the Claude Code configuration that connects an agent to Fiada: the
// MCP server command and the hooks block. From a checkout or an installed
// package they run this copy by its absolute path; from npx's cache, which
// npm may clear, they run `npx @fiada/agent@<version>` instead.
// With --write it merges the hooks into <project>/.claude/settings.local.json
// (Claude Code's per-user, git-ignored settings) and registers the MCP server
// for that project with `claude mcp add`.
//
// With --url (and --token, for an indexer people sign in to) it saves where to
// report to the agent config file (env.ts), so the hook and MCP server need
// no variables. The map's "connect an agent" gives the whole command.

import './env.ts';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configPath, readConfig, type AgentConfig } from './env.ts';

const exec = promisify(execFile);
const q = (p: string) => (/[\s"'$]/.test(p) ? JSON.stringify(p) : p);

/** This package's name and version, from the package.json above src/ (a checkout) or dist/ (the published bundle). */
export const PACKAGE: { name: string; version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The commands Claude Code runs for the hook and the MCP server, for this copy of the package in `bin`. */
export function commandsFor(bin: string, pkg = PACKAGE): { hook: string; mcp: string[] } {
  // npx keeps packages in <cache>/_npx/<hash>/, which npm may clear: run through npx, pinned, offline when it can be.
  if (bin.split(/[\\/]/).includes('_npx')) {
    const npx = ['npx', '-y', '--prefer-offline', `${pkg.name}@${pkg.version}`];
    return { hook: [...npx, 'hook'].join(' '), mcp: [...npx, 'mcp'] };
  }
  return { hook: `node ${q(path.join(bin, 'fiada-hook.mjs'))}`, mcp: ['node', path.join(bin, 'fiada-mcp.mjs')] };
}

const { hook: HOOK, mcp: MCP } = commandsFor(fileURLToPath(new URL('../bin/', import.meta.url)));

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

/** Adds Fiada's hooks to a settings object, replacing any earlier Fiada (or Strata) entries and keeping everything else. */
export function mergeHooks(settings: Record<string, any>, block = hooksBlock()): Record<string, any> {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  for (const [event, entries] of Object.entries(block)) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !String(h.command ?? '').match(/(fiada|strata)-hook|@fiada\/agent/)) }))
      .filter((e) => e.hooks.length);
    hooks[event] = [...kept, ...entries];
  }
  return { ...settings, hooks };
}

/** The value after a flag, or undefined when the flag isn't given or is followed by another flag. */
export function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  return value?.startsWith('--') ? undefined : value;
}

/** The config setup saves: a new URL drops a token that was for another indexer. */
export function nextConfig(before: AgentConfig, url: string, token?: string): AgentConfig {
  const trimmed = url.trim().replace(/\/+$/, '');
  const same = before.url?.replace(/\/+$/, '') === trimmed;
  const keep = token ?? (same ? before.token : undefined);
  return { url: trimmed, ...(keep ? { token: keep } : {}) };
}

/** Saves the config and says whether the indexer takes it. */
async function connect(url: string, token?: string) {
  const file = configPath();
  const config = nextConfig(readConfig(file), url, token);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // The token lets anyone report to this person's map: readable by them alone.
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => undefined);
  console.log(`Agents will report to ${config.url} (saved in ${file})`);
  // An empty batch is a no-op the indexer answers only for a good token.
  try {
    const res = await fetch(`${config.url}/api/agent/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: '[]',
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) console.log('Fiada answered: the token works.');
    else if (res.status === 401) console.log('Fiada turned the token down. Copy the command from the map again (a new token stops the old one).');
    else console.log(`Fiada answered ${res.status}; agents will keep trying.`);
  } catch {
    console.log(`Couldn't reach ${config.url} just now; agents will report once it answers.`);
  }
}

/** Runs setup (`fiada setup`) with its arguments. */
export async function runSetup(args: string[]) {
  const url = flag(args, '--url');
  if (url) await connect(url, flag(args, '--token'));
  const at = args.indexOf('--write');
  if (at < 0) {
    if (url) return;
    console.log(`Connect Claude Code to Fiada

1. The MCP server (run in your project):

   claude mcp add fiada -- ${MCP.map(q).join(' ')}

2. The hooks, in your project's .claude/settings.local.json (or .claude/settings.json to share them, or ~/.claude/settings.json for every project):

${JSON.stringify({ hooks: hooksBlock() }, null, 2).replace(/^/gm, '   ')}

Or let this do both, in your project:  npx @fiada/agent setup --write .

To report to a hosted map, add --url <indexer> --token <token>; the map's "connect an agent" gives the whole command.
`);
    return;
  }
  // npm run and npx start in another folder; INIT_CWD is where the command was typed.
  const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), flag(args, '--write') ?? '.');
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
    // Before the rename the server was registered as "strata"; replace it.
    await exec('claude', ['mcp', 'remove', 'strata'], { cwd: dir }).catch(() => undefined);
    await exec('claude', ['mcp', 'remove', 'fiada'], { cwd: dir }).catch(() => undefined);
    await exec('claude', ['mcp', 'add', 'fiada', '--', ...MCP], { cwd: dir });
    console.log(`MCP server "fiada" added for ${dir}`);
  } catch {
    console.log(`Couldn't run \`claude mcp add\`; in ${dir}, run:\n  claude mcp add fiada -- ${MCP.map(q).join(' ')}`);
  }
}
