// ProjectStore on Postgres (Supabase in production), in its own schema so
// Supabase's REST API, which serves only `public`, never exposes it:
//
//   projects   one row per project: repos, grouping and fences as jsonb, each with its revision
//   summaries  one row per generated node summary, keyed by project and the hash of what the model read
//   accounts   one row per person signed in with GitHub; the token is sealed (auth.ts)
//
// Each save touches only its own column, so saving repos never overwrites the
// grouping or the fences. Each column also carries a revision: a save applies
// only on top of the revision this process last loaded or saved, so two
// indexers serving the same project can't silently undo each other's changes;
// the later one gets a ProjectConflictError telling it to restart instead.
// Saving a value that hasn't changed since it was loaded is skipped, so
// re-saving the same repo list after indexing doesn't make other indexers stale.

import postgres, { type Sql } from 'postgres';
import type { Fence, Grouping } from '@fiada/shared';
import type { ProjectStore, SavedRepo, SignedIn, StoredAccount, StoredSummary, StoredUsage } from './store.ts';

type Field = 'repos' | 'grouping' | 'fences';

/** Another indexer saved this part of the project after this one loaded it. */
export class ProjectConflictError extends Error {
  constructor(projectId: string, field: Field) {
    super(`Project "${projectId}" ${field} were saved by another Fiada indexer after this one loaded them. Restart this indexer to pick up those changes.`);
    this.name = 'ProjectConflictError';
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The tables, made on first connect. Row level security with no policies keeps out every role but the owner the indexer connects as. */
const tables = (schema: string) => `
  create schema if not exists ${schema};
  create table if not exists ${schema}.projects (
    id text primary key,
    repos jsonb, repos_rev integer not null default 0,
    grouping jsonb, grouping_rev integer not null default 0,
    fences jsonb, fences_rev integer not null default 0,
    updated_at timestamptz not null default now()
  );
  create table if not exists ${schema}.summaries (
    project text not null,
    hash text not null,
    text text not null,
    model text not null,
    at text not null,
    primary key (project, hash)
  );
  create table if not exists ${schema}.accounts (
    id text primary key,
    github_id bigint not null,
    login text not null,
    name text,
    avatar text,
    sealed_token text not null,
    scopes text not null,
    agent_epoch integer not null default 0,
    created_at text not null,
    updated_at text not null
  );
  alter table ${schema}.projects enable row level security;
  alter table ${schema}.summaries enable row level security;
  alter table ${schema}.accounts enable row level security;
`;

interface AccountRow {
  id: string;
  github_id: string;
  login: string;
  name: string | null;
  avatar: string | null;
  sealed_token: string;
  scopes: string;
  agent_epoch: number;
  created_at: string;
  updated_at: string;
}

export class PostgresProjectStore implements ProjectStore {
  /** Revision last seen per project and field; 0 = never saved. */
  private revs = new Map<string, number>();
  /** The stored value at that revision, as canonical JSON, to skip no-op saves. */
  private stored = new Map<string, string>();
  /**
   * Loads and saves of one project field run one at a time, so overlapping
   * saves from this process each build on the revision the previous one wrote
   * instead of racing and failing as if another indexer had saved.
   */
  private queues = new Map<string, Promise<unknown>>();
  private projects;
  private summaries;
  private accounts;

  private constructor(
    private sql: Sql,
    schema: string,
    private where: string,
  ) {
    this.projects = sql(`${schema}.projects`);
    this.summaries = sql(`${schema}.summaries`);
    this.accounts = sql(`${schema}.accounts`);
  }

  /**
   * Connects, makes the tables if they're missing and reads from one, so a bad
   * password, an unreachable host or a role without access fails here, at
   * startup, not mid-run.
   */
  static async connect(url: string, schema = 'fiada'): Promise<PostgresProjectStore> {
    if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name "${schema}"`);
    // TLS everywhere but this machine, since a hosted pooler such as Supabase's also takes plain connections.
    // A non-empty sslmode in the URL decides instead.
    const u = parse(url);
    const options = { max: 4, connect_timeout: 8, prepare: false, onnotice: () => {} };

    if (!u?.searchParams.get('sslmode')) Object.assign(options, { ssl: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u?.hostname ?? '') ? false : 'require' });
    const sql = postgres(url, options);

    try {
      await sql.unsafe(tables(schema));
      const store = new PostgresProjectStore(sql, schema, `${redact(url)} ${schema}.projects`);
      await store.ping();

      return store;
    } catch (err) {
      await sql.end().catch(() => {});
      throw err;
    }
  }

  describe(projectId: string) {
    return `${this.where} (${projectId})`;
  }

  /** One real query, so a health check proves the database answers. */
  async ping() {
    await this.sql`select 1 from ${this.projects} limit 1`;
  }

  async loadRepos(projectId: string): Promise<SavedRepo[] | null> {
    const value = await this.load(projectId, 'repos');

    return value == null ? null : Array.isArray(value) ? (value as SavedRepo[]) : [];
  }

  saveRepos(projectId: string, repos: SavedRepo[]) {
    return this.save(projectId, 'repos', repos);
  }

  loadGrouping(projectId: string): Promise<unknown | null> {
    return this.load(projectId, 'grouping');
  }

  saveGrouping(projectId: string, grouping: Grouping) {
    return this.save(projectId, 'grouping', grouping);
  }

  async loadFences(projectId: string): Promise<Fence[] | null> {
    const value = await this.load(projectId, 'fences');

    return value == null ? null : Array.isArray(value) ? (value as Fence[]) : [];
  }

  saveFences(projectId: string, fences: Fence[]) {
    return this.save(projectId, 'fences', fences);
  }

  async loadSummaries(projectId: string): Promise<Record<string, StoredSummary> | null> {
    const rows = await this.sql<{ hash: string; text: string; model: string; at: string }[]>`
      select hash, text, model, at from ${this.summaries} where project = ${projectId}`;

    if (!rows.length) return null;

    return Object.fromEntries(rows.map((r) => [r.hash, { text: r.text, model: r.model, at: r.at }]));
  }

  async saveSummaries(projectId: string, entries: Record<string, StoredSummary>) {
    const rows = Object.entries(entries).map(([hash, s]) => ({ project: projectId, hash, text: s.text, model: s.model, at: s.at }));

    if (!rows.length) return;
    await this.sql`
      insert into ${this.summaries} ${this.sql(rows, 'project', 'hash', 'text', 'model', 'at')}
      on conflict (project, hash) do update set text = excluded.text, model = excluded.model, at = excluded.at`;
  }

  async loadAccount(id: string): Promise<StoredAccount | null> {
    const [row] = await this.sql<AccountRow[]>`select * from ${this.accounts} where id = ${id}`;

    return row ? fromRow(row) : null;
  }

  async saveSignIn(fields: SignedIn): Promise<StoredAccount> {
    const [row] = await this.sql<AccountRow[]>`
      insert into ${this.accounts} (id, github_id, login, name, avatar, sealed_token, scopes, agent_epoch, created_at, updated_at)
      values (${fields.id}, ${fields.githubId}, ${fields.login}, ${fields.name ?? null}, ${fields.avatar ?? null},
              ${fields.sealedToken}, ${fields.scopes}, 0, ${fields.updatedAt}, ${fields.updatedAt})
      on conflict (id) do update set
        github_id = excluded.github_id, login = excluded.login, name = excluded.name, avatar = excluded.avatar,
        sealed_token = excluded.sealed_token, scopes = excluded.scopes, updated_at = excluded.updated_at
      returning *`;

    return fromRow(row);
  }

  async bumpAgentEpoch(id: string, at: string): Promise<StoredAccount | null> {
    const [row] = await this.sql<AccountRow[]>`
      update ${this.accounts} set agent_epoch = agent_epoch + 1, updated_at = ${at} where id = ${id} returning *`;

    return row ? fromRow(row) : null;
  }

  async deleteProject(projectId: string) {
    await this.sql.begin((tx) => [
      tx`delete from ${this.projects} where id = ${projectId}`,
      tx`delete from ${this.summaries} where project = ${projectId}`,
    ]);

    // A project made again under this id starts from nothing, as a new one does.
    for (const field of ['repos', 'grouping', 'fences'] as const) {
      this.revs.delete(`${projectId}\0${field}`);
      this.stored.delete(`${projectId}\0${field}`);
    }
  }

  async deleteAccount(id: string) {
    await this.sql`delete from ${this.accounts} where id = ${id}`;
  }

  async usage(): Promise<StoredUsage> {
    const [accounts, projects] = await Promise.all([
      this.sql<{ created_at: string; updated_at: string }[]>`select created_at, updated_at from ${this.accounts}`,
      // Counted in the database, so no project's repository list is loaded.
      this.sql<{ n: number }[]>`
        select case when jsonb_typeof(repos) = 'array' then jsonb_array_length(repos) else 0 end as n from ${this.projects}`,
    ]);

    return {
      accounts: accounts.map((a) => ({ createdAt: a.created_at, updatedAt: a.updated_at })),
      reposPerProject: projects.map((p) => p.n),
    };
  }

  async close() {
    await this.sql.end();
  }

  private inTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(run);
    this.queues.set(key, result.catch(() => {}));

    return result;
  }

  private load(projectId: string, field: Field): Promise<unknown | null> {
    const key = `${projectId}\0${field}`;

    return this.inTurn(key, () => this.loadNow(key, projectId, field));
  }

  private save(projectId: string, field: Field, value: unknown): Promise<void> {
    const key = `${projectId}\0${field}`;

    return this.inTurn(key, () => this.saveNow(key, projectId, field, value));
  }

  private async loadNow(key: string, projectId: string, field: Field): Promise<unknown | null> {
    const [row] = await this.sql<{ value: unknown; rev: number }[]>`
      select ${this.sql(field)} as value, ${this.sql(`${field}_rev`)} as rev from ${this.projects} where id = ${projectId}`;

    this.revs.set(key, row?.rev ?? 0);

    if (row?.value == null) {
      this.stored.delete(key);

      return null;
    }

    this.stored.set(key, canonical(row.value));

    return row.value;
  }

  private async saveNow(key: string, projectId: string, field: Field, value: unknown) {
    const seen = this.revs.get(key) ?? 0;
    const json = canonical(value);

    if (seen > 0 && this.stored.get(key) === json) return;
    const col = this.sql(field);
    const rev = this.sql(`${field}_rev`);
    const data = this.sql.json(value as postgres.JSONValue);

    // First save of this field: it must not exist yet. The insert creates the
    // row when the project is new; when another indexer saved the field
    // first, its revision isn't 0 and the update matches nothing.
    const result =
      seen === 0
        ? await this.sql`
            insert into ${this.projects} (id, ${col}, ${rev}) values (${projectId}, ${data}, 1)
            on conflict (id) do update set ${col} = excluded.${col}, ${rev} = 1, updated_at = now()
            where ${this.projects}.${rev} = 0`
        : await this.sql`
            update ${this.projects} set ${col} = ${data}, ${rev} = ${seen + 1}, updated_at = now()
            where id = ${projectId} and ${rev} = ${seen}`;

    if (result.count === 0) throw new ProjectConflictError(projectId, field);
    this.revs.set(key, seen + 1);
    this.stored.set(key, json);
  }
}

function fromRow(r: AccountRow): StoredAccount {
  const account: StoredAccount = {
    id: r.id,
    githubId: Number(r.github_id),
    login: r.login,
    sealedToken: r.sealed_token,
    scopes: r.scopes,
    agentEpoch: r.agent_epoch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

  // Left out rather than undefined when unset, as the file store keeps them.
  if (r.name != null) account.name = r.name;

  if (r.avatar != null) account.avatar = r.avatar;

  return account;
}

/** JSON with every object's keys sorted, since jsonb doesn't keep the order they were saved in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/**
 * A connection string as pasted into a host's settings: trimmed, without the
 * quotes a .env line wraps it in, which the driver would read as part of it.
 */
export function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** Scheme, host and port of a connection string: no user, password or options. */
export function redact(uri: string): string {
  const u = parse(uri);

  return u?.host ? `${u.protocol}//${u.host}` : 'the configured server';
}
