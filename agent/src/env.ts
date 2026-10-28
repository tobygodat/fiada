// Where to report and with what token, settled before anything reads them.
// Imported first by every entry point.
//
// `bun run agent:setup --url … --token …` saves both to a config file in
// the user's config folder, so an agent needs no variables set by hand.
// FIADA_URL and FIADA_TOKEN in the environment still win. The saved token is
// only sent to the saved URL: pointing FIADA_URL somewhere else never hands
// that indexer your token.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fiada was called Strata, and agents may already be set up with STRATA_*
// variables. Each one still counts under its FIADA_* name, and wins when both
// are set.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('STRATA_') && value !== undefined) process.env[`FIADA_${name.slice('STRATA_'.length)}`] = value;
}

/** What setup saves: the indexer's URL and the person's agent token. */
export interface AgentConfig {
  url?: string;
  token?: string;
}

/** The config file: FIADA_CONFIG, else fiada/agent.json in the user's config folder. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FIADA_CONFIG) return env.FIADA_CONFIG;
  const base = process.platform === 'win32' ? (env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')) : (env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));

  return path.join(base, 'fiada', 'agent.json');
}

export function readConfig(file = configPath()): AgentConfig {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));

    return {
      ...(typeof c?.url === 'string' ? { url: c.url } : {}),
      ...(typeof c?.token === 'string' ? { token: c.token } : {}),
    };
  } catch {
    return {};
  }
}

const trim = (url: string) => url.trim().replace(/\/+$/, '');

/** Fills FIADA_URL and FIADA_TOKEN from the config where the environment doesn't set them. */
export function applyConfig(env: NodeJS.ProcessEnv, config: AgentConfig) {
  if (!config.url) return;

  if (!env.FIADA_URL) env.FIADA_URL = config.url;

  if (config.token && !env.FIADA_TOKEN && trim(env.FIADA_URL) === trim(config.url)) env.FIADA_TOKEN = config.token;
}

applyConfig(process.env, readConfig());
