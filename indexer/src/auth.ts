// Signing in with GitHub, for an indexer that many people share. When
// FIADA_GITHUB_CLIENT_ID and FIADA_GITHUB_CLIENT_SECRET are set, every request
// needs a signed-in person, and each person gets a project of their own (see
// tenants.ts). Their GitHub token clones their private repositories.
//
// Nothing about a sign-in is kept beyond the account itself. The tokens the
// map and the agent carry are signed rather than stored:
//   fs_<payload>.<signature>   a session, for the map, which expires
//   fa_<payload>.<signature>   an agent token, for the hook and MCP server, which lasts
//                              until the person resets it (the account's agentEpoch)
// The GitHub token is kept on the account sealed with AES-GCM, so a copy of
// the store alone doesn't hand it out.
//
// The signing and sealing keys come from FIADA_SESSION_SECRET, or else from
// the GitHub client secret, so a host needs no extra variable. Changing that
// secret signs everyone out; they sign in again and their projects are kept.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccountInfo } from '@fiada/shared';
import type { ProjectStore, StoredAccount } from './store.ts';

/** How long a sign-in lasts in one browser. */
export const SESSION_DAYS = 30;

/**
 * How long an account read from the store is trusted. Other indexers sharing
 * the store may reset an agent token or save a new GitHub token; this is the
 * longest a reset old token keeps working here.
 */
export const ACCOUNT_TTL_MS = 30_000;

/** How long someone has to finish signing in at GitHub. */
const LOGIN_MINUTES = 10;

/** The cookie that ties a sign-in's return to the browser that started it. */
export const NONCE_COOKIE = 'fiada_oauth';

/** Where the callback lives, under the indexer's public URL. */
export const CALLBACK_PATH = '/api/auth/github/callback';

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /** Key material for signing tokens and sealing GitHub tokens. */
  secret: string;
  /** GitHub scopes asked for: "repo" is what reading private repositories takes. */
  scope: string;
}

/** The sign-in configuration from the environment, or null when GitHub sign-in is off. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const clientId = env.FIADA_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.FIADA_GITHUB_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    secret: env.FIADA_SESSION_SECRET?.trim() || clientSecret,
    scope: env.FIADA_GITHUB_SCOPE?.trim() || 'read:user repo',
  };
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** A signed-in person's project id, from their GitHub user id, which survives a change of login. */
export const accountId = (githubId: number) => `gh-${githubId}`;

/** What the map is told about the person signed in. */
export function accountInfo(a: StoredAccount): AccountInfo {
  return { login: a.login, name: a.name, avatar: a.avatar, privateRepos: /(^|[\s,])repo([\s,]|$)/.test(a.scopes) };
}

/**
 * Whether the sign-in may hand its session to `returnTo`: a page on the
 * indexer's own origin (the dev server's proxy), or on an origin allowed to
 * call the API. Anything else could collect someone's session.
 */
export function returnAllowed(returnTo: string, ownOrigin: string, allowedOrigin: (o: string) => boolean): boolean {
  let url: URL;

  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  return url.origin === ownOrigin || allowedOrigin(url.origin);
}

/** A cookie's value from a Cookie header. */
export function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');

    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }

  return undefined;
}

type SessionClaims = { k: 's'; u: string; x: number };

type AgentClaims = { k: 'a'; u: string; e: number };

type StateClaims = { k: 'o'; r: string; n: string; x: number };

type Claims = SessionClaims | AgentClaims | StateClaims;

const PREFIX = { s: 'fs_', a: 'fa_', o: '' } as const;

/** Talks to GitHub: swapped out in tests. */
export interface GitHubApi {
  exchange(code: string, redirectUri: string): Promise<{ token: string; scopes: string }>;
  user(token: string): Promise<{ id: number; login: string; name?: string; avatar?: string; scopes?: string }>;
  /** The person's repositories, most recently pushed first, as owner/name. */
  repos(token: string, limit: number): Promise<string[]>;
  /** Withdraws the access the person granted this OAuth app, so GitHub lists it no more and the token stops working. */
  revoke(token: string): Promise<void>;
}

export class Auth {
  private signKey: Buffer;
  private sealKey: Buffer;
  /** Accounts read recently, by id, and when: every request checks one. */
  private accounts = new Map<string, { account: Promise<StoredAccount | null>; at: number }>();

  constructor(
    private store: ProjectStore,
    readonly config: AuthConfig,
    private github: GitHubApi = gitHubApi(config),
    private now: () => number = Date.now,
  ) {
    if (!store.loadAccount || !store.saveSignIn || !store.bumpAgentEpoch || !store.deleteAccount) throw new Error('GitHub sign-in needs a store that keeps accounts.');
    this.signKey = createHmac('sha256', config.secret).update('fiada sign').digest();
    this.sealKey = createHmac('sha256', config.secret).update('fiada seal').digest();
  }

  // ── tokens ──

  private sign(claims: Claims): string {
    const body = `${PREFIX[claims.k]}${b64(Buffer.from(JSON.stringify(claims)))}`;

    return `${body}.${b64(createHmac('sha256', this.signKey).update(body).digest())}`;
  }

  private open<K extends Claims['k']>(token: string, kind: K): Extract<Claims, { k: K }> | null {
    const dot = token.lastIndexOf('.');

    if (dot < 0 || !token.startsWith(PREFIX[kind])) return null;
    const body = token.slice(0, dot);
    const given = unb64(token.slice(dot + 1));
    const want = createHmac('sha256', this.signKey).update(body).digest();

    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

    try {
      const claims = JSON.parse(unb64(body.slice(PREFIX[kind].length)).toString('utf8')) as Claims;

      return claims.k === kind ? (claims as Extract<Claims, { k: K }>) : null;
    } catch {
      return null;
    }
  }

  sessionToken(account: StoredAccount): string {
    return this.sign({ k: 's', u: account.id, x: Math.floor(this.now() / 1000) + SESSION_DAYS * 86400 });
  }

  agentToken(account: StoredAccount): string {
    return this.sign({ k: 'a', u: account.id, e: account.agentEpoch });
  }

  /** The account a session token belongs to, or null when it is forged, expired or its account is gone. */
  async session(token: string | undefined): Promise<StoredAccount | null> {
    const c = token ? this.open(token, 's') : null;

    if (!c || c.x * 1000 < this.now()) return null;

    return this.account(c.u);
  }

  /** The account an agent token belongs to, or null when it is forged or was reset. */
  async agent(token: string | undefined): Promise<StoredAccount | null> {
    const c = token ? this.open(token, 'a') : null;

    if (!c) return null;
    let account = await this.account(c.u);

    // A token newer than what we read: another indexer reset it since, so read again.
    if (account && c.e > account.agentEpoch) account = await this.account(c.u, true);

    return account && account.agentEpoch === c.e ? account : null;
  }

  /** Revokes every agent token the account was given, and returns its new one. */
  async resetAgentToken(account: StoredAccount): Promise<string> {
    // One step in the store, so a reset on another indexer at the same time counts too.
    const next = await this.store.bumpAgentEpoch!(account.id, new Date(this.now()).toISOString());

    if (!next) throw new Error(`No account ${account.id} to reset.`);
    this.remember(next);

    return this.agentToken(next);
  }

  // ── the GitHub token ──

  seal(token: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.sealKey, iv);
    const data = Buffer.concat([c.update(token, 'utf8'), c.final()]);

    return b64(Buffer.concat([iv, c.getAuthTag(), data]));
  }

  /** The account's GitHub token, or null when it was sealed with another secret. */
  unseal(sealed: string): string | null {
    try {
      const raw = unb64(sealed);
      const d = createDecipheriv('aes-256-gcm', this.sealKey, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));

      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** The GitHub token of an account, as it is now (signing in again replaces it). */
  async githubToken(id: string): Promise<string | null> {
    const account = await this.account(id);

    return account ? this.unseal(account.sealedToken) : null;
  }

  /** The person's most recently pushed repositories, to offer on the map; empty when GitHub doesn't answer. */
  async recentRepos(id: string, limit = 6): Promise<string[]> {
    const token = await this.githubToken(id);

    return token ? this.github.repos(token, limit).catch(() => []) : [];
  }

  /**
   * Deletes the account: withdraws its grant at GitHub (as far as GitHub
   * answers), then forgets it here, which ends its sessions and agent tokens.
   * The project's own data is the caller's to delete.
   */
  async deleteAccount(account: StoredAccount): Promise<void> {
    const token = this.unseal(account.sealedToken);

    if (token) await this.github.revoke(token).catch((err) => console.warn(`[fiada] couldn't revoke ${account.login}'s GitHub grant: ${(err as Error).message}`));
    await this.store.deleteAccount!(account.id);
    this.accounts.set(account.id, { account: Promise.resolve(null), at: this.now() });
  }

  // ── signing in ──

  /**
   * Where to send the browser to sign in, and the nonce to set as a cookie so
   * only this browser can finish it. `returnTo` must already be allowed.
   */
  begin(returnTo: string, callbackUrl: string) {
    const nonce = b64(randomBytes(16));
    const state = this.sign({ k: 'o', r: returnTo, n: nonce, x: Math.floor(this.now() / 1000) + LOGIN_MINUTES * 60 });
    const q = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: callbackUrl, scope: this.config.scope, state, allow_signup: 'true' });

    return { url: `https://github.com/login/oauth/authorize?${q}`, nonce };
  }

  /** Where a sign-in asked to return to, if its state is genuine and unexpired, whatever else went wrong. */
  returnOf(state: string | undefined): string | null {
    const c = state ? this.open(state, 'o') : null;

    return c && c.x * 1000 >= this.now() ? c.r : null;
  }

  /**
   * Finishes a sign-in: checks the state against the browser's nonce, trades
   * the code for a GitHub token, and saves the account. Throws with a message
   * fit for the person signing in.
   */
  async finish(code: string | undefined, state: string | undefined, nonce: string | undefined, callbackUrl: string): Promise<{ account: StoredAccount; returnTo: string; session: string }> {
    const c = state ? this.open(state, 'o') : null;

    if (!c || c.x * 1000 < this.now()) throw new Error('That sign-in expired. Try again.');

    if (!nonce || nonce !== c.n) throw new Error('That sign-in was started in another browser. Try again from here.');

    if (!code) throw new Error('GitHub did not sign you in.');
    const { token, scopes } = await this.github.exchange(code, callbackUrl);
    const user = await this.github.user(token);

    // The store keeps the agent epoch as it is: signing in never revokes or restores an agent token.
    const account = await this.store.saveSignIn!({
      id: accountId(user.id),
      githubId: user.id,
      login: user.login,
      ...(user.name ? { name: user.name } : {}),
      ...(user.avatar ? { avatar: user.avatar } : {}),
      sealedToken: this.seal(token),
      scopes: user.scopes ?? scopes,
      updatedAt: new Date(this.now()).toISOString(),
    });

    this.remember(account);

    return { account, returnTo: c.r, session: this.sessionToken(account) };
  }

  /** The account, from the store when what was read is older than ACCOUNT_TTL_MS (or `fresh` asks). */
  private account(id: string, fresh = false): Promise<StoredAccount | null> {
    const hit = this.accounts.get(id);

    if (hit && !fresh && this.now() - hit.at < ACCOUNT_TTL_MS) return hit.account;

    const entry = {
      account: this.store.loadAccount!(id).catch((err) => {
        if (this.accounts.get(id) === entry) this.accounts.delete(id);
        throw err;
      }),
      at: this.now(),
    };

    this.accounts.set(id, entry);

    return entry.account;
  }

  private remember(account: StoredAccount) {
    this.accounts.set(account.id, { account: Promise.resolve(account), at: this.now() });
  }
}

/** Bearer token from an Authorization header. */
export function bearer(authorization: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim() || undefined;
}

const UA = 'fiada-indexer';

/** GitHub's OAuth and REST endpoints. */
export function gitHubApi(config: Pick<AuthConfig, 'clientId' | 'clientSecret'>, fetchImpl: typeof fetch = fetch): GitHubApi {
  const api = async (token: string, path: string) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': UA, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);

    return { body: (await res.json()) as any, scopes: res.headers.get('x-oauth-scopes') ?? undefined };
  };

  return {
    async exchange(code, redirectUri) {
      const res = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });

      const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error_description?: string };

      if (!res.ok || !body.access_token) throw new Error(`GitHub didn't sign you in: ${body.error_description ?? `it answered ${res.status}`}.`);

      return { token: body.access_token, scopes: body.scope ?? '' };
    },
    async user(token) {
      const { body, scopes } = await api(token, '/user');

      return { id: Number(body.id), login: String(body.login), name: body.name || undefined, avatar: body.avatar_url || undefined, scopes };
    },
    async repos(token, limit) {
      const { body } = await api(token, `/user/repos?sort=pushed&per_page=${limit}`);

      return Array.isArray(body) ? body.map((r: { full_name: string }) => r.full_name).filter(Boolean) : [];
    },
    async revoke(token) {
      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

      const res = await fetchImpl(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/grant`, {
        method: 'DELETE',
        headers: { accept: 'application/vnd.github+json', authorization: `Basic ${basic}`, 'content-type': 'application/json', 'user-agent': UA, 'x-github-api-version': '2022-11-28' },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(10_000),
      });

      // 404: the grant is gone already.
      if (!res.ok && res.status !== 404) throw new Error(`GitHub answered ${res.status}`);
    },
  };
}
