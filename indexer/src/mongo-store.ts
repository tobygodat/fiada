// ProjectStore on MongoDB (Atlas): one document per project in `projects`,
// keyed by project id, holding the repo list and the grouping side by side.
//
//   { _id: "default", repos: [...], reposRev: 3, grouping: {...}, groupingRev: 7, updatedAt }
//
// Each save touches only its own field, so saving repos never overwrites the
// grouping. Each field also carries a revision: a save applies only on top of
// the revision this process last loaded or saved, so two indexers serving the
// same project can't silently undo each other's changes; the later one gets a
// ProjectConflictError telling it to restart instead. Saving a value that
// hasn't changed since it was loaded is skipped, so re-saving the same repo
// list after indexing doesn't make other indexers stale.

import { MongoClient, type Collection } from 'mongodb';
import type { Grouping } from '@strata/shared';
import type { ProjectStore, SavedRepo } from './store.ts';

interface ProjectDoc {
  _id: string;
  repos?: unknown;
  reposRev?: number;
  grouping?: unknown;
  groupingRev?: number;
  updatedAt?: Date;
}

type Field = 'repos' | 'grouping';

/** Another indexer saved this part of the project after this one loaded it. */
export class ProjectConflictError extends Error {
  constructor(projectId: string, field: Field) {
    super(`Project "${projectId}" ${field} were saved by another Strata indexer after this one loaded them. Restart this indexer to pick up those changes.`);
    this.name = 'ProjectConflictError';
  }
}

export class MongoProjectStore implements ProjectStore {
  /** Revision last seen per project and field; 0 = never saved. */
  private revs = new Map<string, number>();
  /** The stored (encoded) value at that revision, as JSON, to skip no-op saves. */
  private stored = new Map<string, string>();

  private constructor(
    private client: MongoClient,
    private projects: Collection<ProjectDoc>,
    private where: string,
  ) {}

  /**
   * Connects and reads from the collection once, so a bad password, a blocked
   * IP or a user without read access fails here, at startup, not mid-run.
   */
  static async connect(uri: string, dbName = 'strata'): Promise<MongoProjectStore> {
    const client = new MongoClient(uri, { appName: 'strata', serverSelectionTimeoutMS: 8000 });
    try {
      await client.connect();
      const projects = client.db(dbName).collection<ProjectDoc>('projects');
      await projects.findOne({}, { projection: { _id: 1 } });
      return new MongoProjectStore(client, projects, `${redact(uri)} ${dbName}.projects`);
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

  async close() {
    await this.client.close();
  }

  private async load(projectId: string, field: Field): Promise<unknown | null> {
    const rev = `${field}Rev` as const;
    const doc = await this.projects.findOne({ _id: projectId }, { projection: { [field]: 1, [rev]: 1 } });
    const key = `${projectId}\0${field}`;
    this.revs.set(key, doc?.[rev] ?? 0);
    if (doc?.[field] == null) {
      this.stored.delete(key);
      return null;
    }
    this.stored.set(key, JSON.stringify(doc[field]));
    return decodeKeys(doc[field]);
  }

  private async save(projectId: string, field: Field, value: unknown) {
    const key = `${projectId}\0${field}`;
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
