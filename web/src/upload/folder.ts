// Uploading a folder from this computer: pick it, walk it leaving behind what
// .gitignore ignores, dependencies, build output and history, and pack the
// source the indexer reads into one gzipped tar with the few .git files that
// name its remote and HEAD. The indexer unpacks and indexes it (see
// indexer/src/upload.ts), so a private repository needs no token.

import type { UploadPolicy } from '@fiada/shared';
import { isIgnored, parseGitignore, type IgnoreRule } from './gitignore.ts';

/** A folder to walk, from the File System Access API or from an <input webkitdirectory>. */
export interface Folder {
  name: string;
  entries(): Promise<FolderEntry[]>;
}

export interface FolderEntry {
  name: string;
  /** Set for a folder. */
  folder?: Folder;
  /** Set for a file. */
  file?: () => Promise<File>;
}

// The File System Access API, which TypeScript's DOM types leave out. Chrome and Edge have it.
interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
}
interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}
type DirectoryPicker = (options?: { id?: string; mode?: 'read' }) => Promise<DirHandle>;

function fromHandle(h: DirHandle): Folder {
  return {
    name: h.name,
    async entries() {
      const out: FolderEntry[] = [];
      for await (const e of h.values()) out.push(e.kind === 'directory' ? { name: e.name, folder: fromHandle(e) } : { name: e.name, file: () => e.getFile() });
      return out;
    },
  };
}

/**
 * The folder an <input webkitdirectory> gave, rebuilt from each file's
 * webkitRelativePath ("folder/src/app.ts"). The browser has listed every
 * file by then, node_modules included; the walk still skips reading them.
 */
export function fromFileList(files: ArrayLike<File>): Folder | null {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, File>;
  }
  const node = (): Node => ({ dirs: new Map(), files: new Map() });
  const top = node();
  let name = '';
  for (const f of Array.from(files)) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    name ||= parts.length > 1 ? parts[0] : '';
    let at = top;
    for (const dir of parts.slice(1, -1)) {
      if (!at.dirs.has(dir)) at.dirs.set(dir, node());
      at = at.dirs.get(dir)!;
    }
    at.files.set(parts[parts.length - 1], f);
  }
  if (!name) return null;
  const folder = (n: string, at: Node): Folder => ({
    name: n,
    entries: async () => [
      ...[...at.dirs].map(([d, sub]) => ({ name: d, folder: folder(d, sub) })),
      ...[...at.files].map(([fn, file]) => ({ name: fn, file: async () => file })),
    ],
  });
  return folder(name, top);
}

/** Whether this browser can open a folder without listing all of it first. */
export const canPickDirectory = () => typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** Asks for a folder with the File System Access API; null when the person cancels. */
export async function pickDirectory(): Promise<Folder | null> {
  const pick = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
  try {
    return fromHandle(await pick({ id: 'fiada-upload', mode: 'read' }));
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  }
}

export interface Picked {
  name: string;
  files: { path: string; file: File }[];
  /** Bytes of source, not counting the .git files. */
  bytes: number;
  /** How many of `files` are source (the rest are .gitignore and .git files). */
  sources: number;
}

const MB = 1 << 20;
const megabytes = (n: number) => `${Math.round(n / MB)} MB`;

/** The .git files that say where a checkout came from (remote, branch and HEAD), none of its history. */
async function gitFiles(git: Folder): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  const all = async (dir: Folder, rel: string, depth: number): Promise<void> => {
    for (const e of await dir.entries()) {
      if (e.file) out.push({ path: `${rel}/${e.name}`, file: await e.file() });
      else if (e.folder && depth < 8) await all(e.folder, `${rel}/${e.name}`, depth + 1);
    }
  };
  for (const e of await git.entries()) {
    if (e.file && ['HEAD', 'config', 'packed-refs'].includes(e.name)) out.push({ path: `.git/${e.name}`, file: await e.file() });
    else if (e.folder && e.name === 'refs') {
      const heads = (await e.folder.entries()).find((r) => r.name === 'heads')?.folder;
      if (heads) await all(heads, '.git/refs/heads', 0);
    }
  }
  return out;
}

/**
 * Walks a folder for the files worth uploading: what `policy` says the
 * indexer reads, outside the folders it never reads and whatever the
 * folder's .gitignore files ignore, plus those .gitignore files and the .git
 * metadata. Stops with a message as soon as the folder is over the limits.
 */
export async function collect(root: Folder, policy: UploadPolicy, onProgress?: (files: number, bytes: number) => void): Promise<Picked> {
  const wanted = new RegExp(policy.files);
  const skip = new Set(policy.skipDirs);
  const picked: Picked = { name: root.name, files: [], bytes: 0, sources: 0 };
  const walk = async (dir: Folder, rel: string, inherited: IgnoreRule[]) => {
    const entries = await dir.entries();
    const gi = entries.find((e) => e.name === '.gitignore' && e.file);
    const rules = gi ? [...inherited, ...parseGitignore(await (await gi.file!()).text(), rel)] : inherited;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === '.git') {
        if (!rel && e.folder) picked.files.push(...(await gitFiles(e.folder)));
      } else if (e.folder) {
        if (!skip.has(e.name) && !isIgnored(rules, p, true)) await walk(e.folder, p, rules);
      } else if (e.file && !isIgnored(rules, p, false) && (e.name === '.gitignore' || wanted.test(p))) {
        const file = await e.file();
        picked.files.push({ path: p, file });
        if (e.name === '.gitignore') continue;
        picked.sources++;
        picked.bytes += file.size;
        if (picked.bytes > policy.maxBytes) {
          throw new Error(`${root.name} has more than ${megabytes(policy.maxBytes)} of source files, the upload limit. Upload a smaller folder, or add generated code to its .gitignore.`);
        }
        if (picked.sources > policy.maxFiles) {
          throw new Error(`${root.name} has more than ${policy.maxFiles.toLocaleString('en-US')} source files, the upload limit. Upload a smaller folder.`);
        }
        if (picked.sources % 200 === 0) onProgress?.(picked.sources, picked.bytes);
      }
    }
  };
  await walk(root, '', []);
  onProgress?.(picked.sources, picked.bytes);
  if (!picked.sources) throw new Error(`Nothing to map in ${root.name}: it has no source files the indexer reads, or .gitignore ignores them all.`);
  return picked;
}

// ── tar ──

const utf8 = new TextEncoder();

function octal(h: Uint8Array, at: number, width: number, n: number) {
  h.set(utf8.encode(`${n.toString(8).padStart(width - 1, '0')}\0`), at);
}

function header(name: Uint8Array, size: number, type: string, mtime: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(512);
  h.set(name.subarray(0, 100), 0);
  octal(h, 100, 8, 0o644);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h[156] = type.charCodeAt(0);
  h.set(utf8.encode('ustar\x0000'), 257);
  h.fill(0x20, 148, 156);
  const sum = h.reduce((a, b) => a + b, 0);
  h.set(utf8.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return h;
}

const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);

/** A pax record ("<length> path=<value>\n"), whose length counts its own digits. */
function paxPath(path: string): Uint8Array<ArrayBuffer> {
  const body = utf8.encode(` path=${path}\n`).length;
  let len = body + 1;
  while (String(len).length + body !== len) len = String(len).length + body;
  return utf8.encode(`${len} path=${path}\n`);
}

/** The tar entries for one file, as Blob parts: the file itself is read only when the archive is. */
export function tarEntry(path: string, file: Blob, mtime = 0): BlobPart[] {
  const name = utf8.encode(path);
  const parts: BlobPart[] = [];
  if (name.length > 100) {
    // Too long for the header's name field: a pax header carries the full name.
    const pax = paxPath(path);
    parts.push(header(utf8.encode('PaxHeader'), pax.length, 'x', mtime), pax, padding(pax.length));
  }
  parts.push(header(name, file.size, '0', mtime), file, padding(file.size));
  return parts;
}

/** The picked files as one gzipped tar. */
export async function pack(picked: Picked): Promise<Blob> {
  const now = Math.floor(Date.now() / 1000);
  const parts = picked.files.flatMap((f) => tarEntry(f.path, f.file, Math.floor(f.file.lastModified / 1000) || now));
  parts.push(new Uint8Array(1024));
  const gz = new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(gz).arrayBuffer()], { type: 'application/gzip' });
}
