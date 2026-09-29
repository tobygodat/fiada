// The command that connects a coding agent to this map (components/Account.tsx).
// It runs the published @fiada/agent package, so no checkout of Fiada is needed.

import type { AgentConnection } from '@fiada/shared';

/**
 * One word for a POSIX shell: left bare when it's plainly safe, else in
 * single quotes, so a shared indexer's key with spaces, `;` or `$` stays one
 * argument and runs nothing.
 */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command that sets an agent up to report here, run in the project's own folder. */
export function setupCommand(c: AgentConnection, token = c.token): string {
  // Several bins and none named after the package, so npx is told which to run.
  // --name=value, so a value starting with dashes can't be taken for another flag.
  return ['npx -y --package=@fiada/agent fiada setup', '--write .', `--url=${shellWord(c.url)}`, ...(token ? [`--token=${shellWord(token)}`] : [])].join(' ');
}
