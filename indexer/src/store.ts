// Persistence boundary for what Strata keeps per project: the repositories
// imported into it, its grouping (layer definitions, domain names, rules and
// pins), and the node summaries a model wrote. The graph is derived from
// those and is never stored.
//
// FileProjectStore is the default. A database-backed store implements the
// same interface (one record per project id) and is chosen in createStore();
// nothing in the indexer, classifier or graph code depends on which one runs.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Grouping } from '@strata/shared';
import { MongoProjectStore, redact, unquote } from './mongo-store.ts';

/** A repository as the project remembers it; everything else about it is re-derived on load. */
export interface SavedRepo {
  id: string;
  name: string;
  /** Clone URL or absolute local path. */
  source: string;
  kind: 'git' | 'local';
}

/** A generated node summary, stored under a hash of what the model read, so it survives restarts and re-indexing. */
export interface StoredSummary {
  text: string;
  model: string;
  /** ISO time it was written. */
  at: string;
}

export interface ProjectStore {
  /** Where this project's data lives, for display ("…/strata.grouping.json", "mongodb: strata.projects"). */
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
  /** Optional: generated summaries by hash, or null when none were saved. */
  loadSummaries?(projectId: string): Promise<Record<string, StoredSummary> | null>;
  /** Optional: adds or replaces these entries; saved entries not named here are kept. */
  saveSummaries?(projectId: string, entries: Record<string, StoredSummary>): Promise<void>;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function checkProjectId(id: string): string {
  if (!PROJECT_ID.test(id)) throw new Error(`Invalid project id "${id}": use letters, digits, ".", "_" or "-".`);
  return id;
}

/**
 * One directory per project under `root`:
 *   projects/<id>/repos.json
 *   projects/<id>/strata.grouping.json   (hand-editable; edits apply live)
 *   projects/<id>/summaries.json         (generated summaries by hash)
 */
export class FileProjectStore implements ProjectStore {
  /** Last text this process wrote, per file, so the watcher ignores our own saves. */
  private written = new Map<string, string>();
  /** Summary saves in flight per project, so each merge reads the one before it. */
  private summaryWrites = new Map<string, Promise<unknown>>();

  constructor(private root: string) {}

  private dir(id: string) {
    return path.join(this.root, 'projects', checkProjectId(id));
  }
  private groupingFile(id: string) {
    return path.join(this.dir(id), 'strata.grouping.json');
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

  private async write(file: string, text: string) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    this.written.set(file, text);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text);
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
      const db = process.env.STRATA_MONGODB_DB?.trim() || 'strata';
      const store = await MongoProjectStore.connect(uri, db);
      console.log(`[strata] saving projects to MongoDB at ${redact(uri)} (${db}.projects)`);
      return store;
    } catch (err) {
      console.error(`[strata] can't use MongoDB at ${redact(uri)}: ${(err as Error).message}`);
      console.error(`[strata] saving to ${path.join(home, 'projects')} for this run instead`);
    }
  }
  return new FileProjectStore(home);
}
