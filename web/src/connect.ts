// The command that connects a coding agent to this map (components/Account.tsx).
// It runs the published @fiada/agent package, so no checkout of Fiada is needed.

import type { AgentConnection } from '@fiada/shared';

/** The command that sets an agent up to report here, run in the project's own folder. */
export function setupCommand(c: AgentConnection, token = c.token): string {
  // Several bins and none named after the package, so npx is told which to run.
  return ['npx -y --package=@fiada/agent fiada setup', '--write .', '--url', c.url, ...(token ? ['--token', token] : [])].join(' ');
}
