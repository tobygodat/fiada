// ProjectStore on MongoDB (Atlas): one document per project in `projects`,
// keyed by project id, holding the repo list and the grouping side by side.
//
//   { _id: "default", repos: [...], reposRev: 3, grouping: {...}, groupingRev: 7, fences: [...], fencesRev: 2, updatedAt }
//
// Generated node summaries go in `summaries`, one document each, keyed by
// project and the hash of what the model read. They're derived and
// write-once, so they need no revisions: two indexers writing the same hash
// write the same kind of thing.
//
//   { _id: "default:Qm3…", project: "default", text, model, at }
//
// Signed-in accounts go in `accounts`, one document each, keyed by account id.
// A sign-in and an agent-token reset each change their own fields in one
// update, so indexers doing both at once can't undo each other.
//
// Each save touches only its own field, so saving repos never overwrites the
// grouping or the fences. Each field also carries a revision: a save applies only on top of
// the revision this process last loaded or saved, so two indexers serving the
// same project can't silently undo each other's changes; the later one gets a
// ProjectConflictError telling it to restart instead. Saving a value that
// hasn't changed since it was loaded is skipped, so re-saving the same repo
// list after indexing doesn't make other indexers stale.

import { MongoClient, type Collection } from 'mongodb';
import type { Fence, Grouping } from '@fiada/shared';
import type { ProjectStore, SavedRepo, SignedIn, StoredAccount, StoredSummary } from './store.ts';

interface ProjectDoc {
  _id: string;
  repos?: unknown;
  reposRev?: number;
  grouping?: unknown;
  groupingRev?: number;
  fences?: unknown;
  fencesRev?: number;
  updatedAt?: Date;
}

interface SummaryDoc extends StoredSummary {
  _id: string;
  project: string;
}

type AccountDoc = Omit<StoredAccount, 'id'> & { _id: string };

type Field = 'repos' | 'grouping' | 'fences';

/** Another indexer saved this part of the project after this one loaded it. */
export class ProjectConflictError extends Error {
  constructor(projectId: string, field: Field) {
    super(`Project "${projectId}" ${field} were saved by another Fiada indexer after this one loaded them. Restart this indexer to pick up those changes.`);
    this.name = 'ProjectConflictError';
  }
}

export class MongoProjectStore implements ProjectStore {
  /** Revision last seen per project and field; 0 = never saved. */
  private revs = new Map<string, number>();
  /** The stored (encoded) value at that revision, as JSON, to skip no-op saves. */
  private stored = new Map<string, string>();
  /**
   * Loads and saves of one project field run one at a time, so overlapping
   * saves from this process each build on the revision the previous one wrote
   * instead of racing and failing as if another indexer had saved.
   */
  private queues = new Map<string, Promise<unknown>>();

  private constructor(
    private client: MongoClient,
    private projects: Collection<ProjectDoc>,
    private summaries: Collection<SummaryDoc>,
    private accounts: Collection<AccountDoc>,
    private where: string,
  ) {}

  /**
   * Connects and reads from the collection once, so a bad password, a blocked
   * IP or a user without read access fails here, at startup, not mid-run.
   */
  static async connect(uri: string, dbName = 'strata'): Promise<MongoProjectStore> {
    const client = new MongoClient(uri, { appName: 'fiada', serverSelectionTimeoutMS: 8000 });
    try {
      await client.connect();
      const projects = client.db(dbName).collection<ProjectDoc>('projects');
      await projects.findOne({}, { projection: { _id: 1 } });
      const summaries = client.db(dbName).collection<SummaryDoc>('summaries');
      const accounts = client.db(dbName).collection<AccountDoc>('accounts');
      return new MongoProjectStore(client, projects, summaries, accounts, `${redact(uri)} ${dbName}.projects`);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  describe(projectId: string) {
    return `${this.where} (${projectId})`;
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
    const docs = await this.summaries.find({ project: projectId }).toArray();
    if (!docs.length) return null;
    return Object.fromEntries(docs.map((d) => [d._id.slice(projectId.length + 1), { text: d.text, model: d.model, at: d.at }]));
  }

  async saveSummaries(projectId: string, entries: Record<string, StoredSummary>) {
    const ops = Object.entries(entries).map(([hash, s]) => ({
      replaceOne: { filter: { _id: `${projectId}:${hash}` }, replacement: { project: projectId, text: s.text, model: s.model, at: s.at }, upsert: true },
    }));
    if (ops.length) await this.summaries.bulkWrite(ops, { ordered: false });
  }

  async loadAccount(id: string): Promise<StoredAccount | null> {
    const doc = await this.accounts.findOne({ _id: id });
    return doc && fromDoc(doc);
  }

  async saveSignIn(fields: SignedIn): Promise<StoredAccount> {
    const { id, ...rest } = fields;
    const doc = await this.accounts.findOneAndUpdate(
      { _id: id },
      { $set: rest, $setOnInsert: { agentEpoch: 0, createdAt: fields.updatedAt } },
      { upsert: true, returnDocument: 'after' },
    );
    return fromDoc(doc!);
  }

  async bumpAgentEpoch(id: string, at: string): Promise<StoredAccount | null> {
    const doc = await this.accounts.findOneAndUpdate({ _id: id }, { $inc: { agentEpoch: 1 }, $set: { updatedAt: at } }, { returnDocument: 'after' });
    return doc && fromDoc(doc);
  }

  async deleteProject(projectId: string) {
    await Promise.all([this.projects.deleteOne({ _id: projectId }), this.summaries.deleteMany({ project: projectId })]);
    // A project made again under this id starts from nothing, as a new one does.
    for (const field of ['repos', 'grouping', 'fences'] as const) {
      this.revs.delete(`${projectId}\0${field}`);
      this.stored.delete(`${projectId}\0${field}`);
    }
  }

  async deleteAccount(id: string) {
    await this.accounts.deleteOne({ _id: id });
  }

  async close() {
    await this.client.close();
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
    const rev = `${field}Rev` as const;
    const doc = await this.projects.findOne({ _id: projectId }, { projection: { [field]: 1, [rev]: 1 } });
    this.revs.set(key, doc?.[rev] ?? 0);
    if (doc?.[field] == null) {
      this.stored.delete(key);
      return null;
    }
    this.stored.set(key, JSON.stringify(doc[field]));
    return decodeKeys(doc[field]);
  }

  private async saveNow(key: string, projectId: string, field: Field, value: unknown) {
    const rev = `${field}Rev` as const;
    const seen = this.revs.get(key) ?? 0;
    const encoded = encodeKeys(value);
    const json = JSON.stringify(encoded);
    if (seen > 0 && this.stored.get(key) === json) return;
    // First save of this field: it must not exist yet. The upsert creates the
    // document when the project is new; when another indexer got there first,
    // nothing matches and the upsert's insert collides on _id.
    const filter = seen === 0 ? { _id: projectId, [rev]: { $exists: false } } : { _id: projectId, [rev]: seen };
    const update = { $set: { [field]: encoded, [rev]: seen + 1, updatedAt: new Date() } };
    try {
      const result = await this.projects.updateOne(filter, update, { upsert: seen === 0 });
      if (result.matchedCount === 0 && result.upsertedCount === 0) throw new ProjectConflictError(projectId, field);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ProjectConflictError(projectId, field);
      throw err;
    }
    this.revs.set(key, seen + 1);
    this.stored.set(key, json);
  }
}

function fromDoc({ _id, ...rest }: AccountDoc): StoredAccount {
  return { id: _id, ...rest };
}

/**
 * A connection string as pasted into a host's settings: trimmed, without the
 * quotes a .env line wraps it in, which the driver would read as part of the
 * host name (querySrv EBADNAME).
 */
export function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
}

/** Scheme and hosts of a connection string: no user, password or options. */
export function redact(uri: string): string {
  const m = /^([a-z+]+:\/\/)(?:[^@/]*@)?([^/?]*)/i.exec(uri);
  return m ? m[1] + m[2] : 'the configured server';
}

// Field names can't start with "$" or contain "." in stored documents, and
// symbol ids (grouping pins are keyed by them) contain dots, as in
// "web/src/api.ts#fetchItems". Percent-escape them, and "%" itself so that
// decoding is exact: "api.ts" is stored as "api%2Ets" and "a%b" as "a%25b".
const ESCAPES: Record<string, string> = { '%': '%25', '.': '%2E', $: '%24' };
const UNESCAPES: Record<string, string> = { '%25': '%', '%2E': '.', '%24': '$' };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

function mapKeys(value: unknown, key: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapKeys(v, key));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [key(k), mapKeys(v, key)]));
}

export const encodeKeys = (value: unknown) => mapKeys(value, (k) => k.replace(/[%.$]/g, (c) => ESCAPES[c]));

export const decodeKeys = (value: unknown) => mapKeys(value, (k) => k.replace(/%(25|2E|24)/g, (e) => UNESCAPES[e]));
