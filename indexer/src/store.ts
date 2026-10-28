// Persistence boundary for what Fiada keeps per project: the repositories
// imported into it, its grouping (layer definitions, domain names, rules and
// pins), its fences (where agents must ask first or keep out), and the node
// summaries a model wrote. The graph is derived from
// those and is never stored. It also keeps the accounts of people who signed
// in with GitHub, each of which owns one project (see auth.ts).
//
// FileProjectStore is the default. A database-backed store implements the
// same interface (one record per project id) and is chosen in createStore();
// nothing in the indexer, classifier or graph code depends on which one runs.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Fence, Grouping, RepoKind } from '@fiada/shared';
import { MongoProjectStore, redact, unquote } from './mongo-store.ts';

/** A repository as the project remembers it; everything else about it is re-derived on load. */
export interface SavedRepo {
  id: string;
  name: string;
  /** Clone URL, absolute local path, or an uploaded folder's name. */
  source: string;
  kind: RepoKind;
  /** An upload's origin remote, branch, short HEAD and time, from what it sent. */
  remote?: string;
  branch?: string;
  commit?: string;
  uploadedAt?: string;
}

/** A generated node summary, stored under a hash of what the model read, so it survives restarts and re-indexing. */
export interface StoredSummary {
  text: string;
  model: string;
  /** ISO time it was written. */
  at: string;
}

/**
 * Someone who signed in with GitHub. Their project is `id`. The GitHub token
 * is stored encrypted (auth.ts), never as given.
 */
export interface StoredAccount {
  /** "gh-<GitHub user id>", which is also their project id. */
  id: string;
  githubId: number;
  login: string;
  name?: string;
  avatar?: string;
  /** The GitHub access token, sealed with the indexer's secret. */
  sealedToken: string;
  /** The scopes GitHub granted, comma-separated as it reports them. */
  scopes: string;
  /** Bumped to revoke every agent token given out before. */
  agentEpoch: number;
  createdAt: string;
  updatedAt: string;
}

/** What signing in writes: everything but the agent epoch and when the account was made, which it never touches. */
export type SignedIn = Omit<StoredAccount, 'agentEpoch' | 'createdAt'>;

/** What the owner's usage numbers are counted from (stats.ts): dates and counts, never who. */
export interface StoredUsage {
  accounts: Pick<StoredAccount, 'createdAt' | 'updatedAt'>[];
  /** How many repositories each saved project keeps. */
  reposPerProject: number[];
}

export interface ProjectStore {
  /** Where this project's data lives, for display ("…/fiada.grouping.json", "mongodb: fiada.projects"). */
  describe(projectId: string): string;
  /** null when the project has never been saved. */
  loadRepos(projectId: string): Promise<SavedRepo[] | null>;
  saveRepos(projectId: string, repos: SavedRepo[]): Promise<void>;
  /** The stored grouping as raw JSON (the caller validates it), or null when there is none yet. */
  loadGrouping(projectId: string): Promise<unknown | null>;
  saveGrouping(projectId: string, grouping: Grouping): Promise<void>;
  /**
   * Optional: call `onChange` when the grouping changes outside this process
   * (a hand edit, another instance). Returns a function that stops watching.
   */
  watchGrouping?(projectId: string, onChange: () => void): () => void;
  /** Optional: the circles marked "ask first" or "off limits", or null when none were ever saved. */
  loadFences?(projectId: string): Promise<Fence[] | null>;
  /** Optional: replaces the project's fences. */
  saveFences?(projectId: string, fences: Fence[]): Promise<void>;
  /** Optional: generated summaries by hash, or null when none were saved. */
  loadSummaries?(projectId: string): Promise<Record<string, StoredSummary> | null>;
  /** Optional: adds or replaces these entries; saved entries not named here are kept. */
  saveSummaries?(projectId: string, entries: Record<string, StoredSummary>): Promise<void>;
  /** A signed-in account, or null when there is none with this id. Both stores have accounts; a store for tests may not. */
  loadAccount?(id: string): Promise<StoredAccount | null>;
  /**
   * Records a sign-in in one step: creates the account (agent epoch 0) or
   * updates its profile and GitHub token, never its agent epoch, so a sign-in
   * can't undo a reset made at the same moment. Returns the account as stored.
   */
  saveSignIn?(fields: SignedIn): Promise<StoredAccount>;
  /** Adds one to the account's agent epoch in one step, revoking its agent tokens. Null when there is no such account. */
  bumpAgentEpoch?(id: string, at: string): Promise<StoredAccount | null>;
  /** Forgets everything the project kept: its repositories, grouping, fences and summaries. */
  deleteProject?(projectId: string): Promise<void>;
  /** Forgets the account, sealed GitHub token and all. */
  deleteAccount?(id: string): Promise<void>;
  /** Optional: every account's sign-up and last sign-in, and every project's repository count. */
  usage?(): Promise<StoredUsage>;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkProjectId(id: string): string {
  if (!PROJECT_ID.test(id)) throw new Error(`Invalid project id "${id}": use letters, digits, ".", "_" or "-".`);

  return id;
}

/**
 * One directory per project under `root`:
 *   projects/<id>/repos.json
 *   projects/<id>/fiada.grouping.json   (hand-editable; edits apply live)
 *   projects/<id>/fences.json            (circles marked "ask first" or "off limits")
 *   projects/<id>/summaries.json         (generated summaries by hash)
 * and one file per signed-in account under accounts/<id>.json.
 */
export class FileProjectStore implements ProjectStore {
  /** Last text this process wrote, per file, so the watcher ignores our own saves. */
  private written = new Map<string, string>();
  /** Summary saves in flight per project, so each merge reads the one before it. */
  private summaryWrites = new Map<string, Promise<unknown>>();
  /** Account changes in flight per account, so each reads the one before it. */
  private accountWrites = new Map<string, Promise<unknown>>();

  constructor(private root: string) {}

  private dir(id: string) {
    return path.join(this.root, 'projects', checkProjectId(id));
  }
  private groupingFile(id: string) {
    // Projects saved before the rename keep their strata.grouping.json.
    const old = path.join(this.dir(id), 'strata.grouping.json');
    const file = path.join(this.dir(id), 'fiada.grouping.json');

    return !fs.existsSync(file) && fs.existsSync(old) ? old : file;
  }

  describe(id: string) {
    return this.groupingFile(id);
  }

  async loadRepos(id: string): Promise<SavedRepo[] | null> {
    const text = await fsp.readFile(path.join(this.dir(id), 'repos.json'), 'utf8').catch(() => null);
    // Before projects existed, the default project lived in <root>/workspace.json.
    const legacy = text == null && id === 'default' ? await fsp.readFile(path.join(this.root, 'workspace.json'), 'utf8').catch(() => null) : null;
    const raw = text ?? legacy;

    if (raw == null) return null;
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed?.repos) ? parsed.repos : [];
  }

  async saveRepos(id: string, repos: SavedRepo[]) {
    await this.write(path.join(this.dir(id), 'repos.json'), JSON.stringify({ repos }, null, 2) + '\n');
  }

  async loadGrouping(id: string): Promise<unknown | null> {
    const text = await fsp.readFile(this.groupingFile(id), 'utf8').catch(() => null);

    return text == null ? null : JSON.parse(text);
  }

  async saveGrouping(id: string, grouping: Grouping) {
    await this.write(this.groupingFile(id), JSON.stringify(grouping, null, 2) + '\n');
  }

  async loadFences(id: string): Promise<Fence[] | null> {
    const text = await fsp.readFile(path.join(this.dir(id), 'fences.json'), 'utf8').catch(() => null);

    if (text == null) return null;
    const parsed = JSON.parse(text);

    return Array.isArray(parsed?.fences) ? parsed.fences : [];
  }

  async saveFences(id: string, fences: Fence[]) {
    await this.write(path.join(this.dir(id), 'fences.json'), JSON.stringify({ fences }, null, 2) + '\n');
  }

  async loadSummaries(id: string): Promise<Record<string, StoredSummary> | null> {
    const text = await fsp.readFile(path.join(this.dir(id), 'summaries.json'), 'utf8').catch(() => null);

    if (text == null) return null;
    const parsed = JSON.parse(text);

    return parsed && typeof parsed.summaries === 'object' ? parsed.summaries : null;
  }

  async saveSummaries(id: string, entries: Record<string, StoredSummary>) {
    const file = path.join(this.dir(id), 'summaries.json');

    // Saves come from one process, one at a time; merge so each only adds what's new.
    const run = (this.summaryWrites.get(id) ?? Promise.resolve()).then(async () => {
      const saved = (await this.loadSummaries(id).catch(() => null)) ?? {};
      await this.write(file, JSON.stringify({ summaries: { ...saved, ...entries } }) + '\n');
    });

    this.summaryWrites.set(id, run.catch(() => {}));

    return run;
  }

  async loadAccount(id: string): Promise<StoredAccount | null> {
    const text = await fsp.readFile(path.join(this.root, 'accounts', `${checkProjectId(id)}.json`), 'utf8').catch(() => null);

    return text == null ? null : (JSON.parse(text) as StoredAccount);
  }

  // Files belong to one indexer, so queuing each account's changes in this process makes them atomic.
  saveSignIn(fields: SignedIn): Promise<StoredAccount> {
    return this.changeAccount(fields.id, (before) => ({ ...before, ...fields, agentEpoch: before?.agentEpoch ?? 0, createdAt: before?.createdAt ?? fields.updatedAt }));
  }

  async bumpAgentEpoch(id: string, at: string): Promise<StoredAccount | null> {
    return this.changeAccount(id, (before) => before && { ...before, agentEpoch: before.agentEpoch + 1, updatedAt: at });
  }

  async deleteProject(id: string) {
    await (this.summaryWrites.get(id) ?? Promise.resolve());
    await fsp.rm(this.dir(id), { recursive: true, force: true });
  }

  async deleteAccount(id: string) {
    const file = path.join(this.root, 'accounts', `${checkProjectId(id)}.json`);
    const run = (this.accountWrites.get(id) ?? Promise.resolve()).then(() => fsp.rm(file, { force: true }));
    this.accountWrites.set(id, run.catch(() => {}));
    await run;
  }

  async usage(): Promise<StoredUsage> {
    const names = (dir: string) => fsp.readdir(path.join(this.root, dir)).catch(() => [] as string[]);
    const read = (file: string) => fsp.readFile(path.join(this.root, file), 'utf8').then(JSON.parse).catch(() => null);
    const accounts = await Promise.all((await names('accounts')).filter((n) => n.endsWith('.json')).map((n) => read(`accounts/${n}`)));
    const repos = await Promise.all((await names('projects')).map((n) => read(`projects/${n}/repos.json`)));

    return {
      accounts: accounts.filter(Boolean).map(({ createdAt, updatedAt }: StoredAccount) => ({ createdAt, updatedAt })),
      reposPerProject: repos.filter(Boolean).map((r) => (Array.isArray(r.repos) ? r.repos.length : 0)),
    };
  }

  private changeAccount<T extends StoredAccount | null>(id: string, change: (before: StoredAccount | null) => T): Promise<T> {
    const run = (this.accountWrites.get(id) ?? Promise.resolve()).then(async () => {
      const next = change(await this.loadAccount(id));

      // Only the indexer reads it: the token in it is sealed, but still.
      if (next) await this.write(path.join(this.root, 'accounts', `${checkProjectId(id)}.json`), JSON.stringify(next, null, 2) + '\n', 0o600);

      return next;
    });

    this.accountWrites.set(id, run.catch(() => {}));

    return run;
  }

  watchGrouping(id: string, onChange: () => void): () => void {
    const file = this.groupingFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let timer: NodeJS.Timeout | undefined;

    // Watch the directory: editors often save by writing a new file and renaming it over the old one.
    const watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const text = await fsp.readFile(file, 'utf8').catch(() => null);

        if (text != null && text !== this.written.get(file)) onChange();
      }, 150);
    });

    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  private async write(file: string, text: string, mode?: number) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    this.written.set(file, text);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, { mode });
    await fsp.rename(tmp, file);
  }
}

/**
 * The store the server uses: MongoDB (Atlas) when MONGODB_URI is set, else
 * files under `home`. If MongoDB can't be reached or read at startup, says
 * why and uses the files for this run, so the map still works offline.
 */
export async function createStore(home: string): Promise<ProjectStore> {
  const uri = unquote(process.env.MONGODB_URI);

  if (uri) {
    try {
      const db = process.env.FIADA_MONGODB_DB?.trim() || 'strata';
      const store = await MongoProjectStore.connect(uri, db);
      console.log(`[fiada] saving projects to MongoDB at ${redact(uri)} (${db}.projects)`);

      return store;
    } catch (err) {
      console.error(`[fiada] can't use MongoDB at ${redact(uri)}: ${(err as Error).message}`);
      console.error(`[fiada] saving to ${path.join(home, 'projects')} for this run instead`);
    }
  }

  return new FileProjectStore(home);
}
