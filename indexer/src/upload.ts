// Folders uploaded from the map. A browser can't hand the indexer a path, and
// a hosted indexer can't clone a private repository without a token, so the
// map sends the folder's source itself: a gzipped tar of the files the
// indexer reads, plus the few .git files that name its remote and HEAD.
// Here that archive is checked and unpacked into a directory that is then
// indexed like a clone.

import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { UploadPolicy } from '@fiada/shared';
import { SOURCE_EXTENSIONS } from './parse/index.ts';
import { IGNORED_DIR, MANIFEST } from './sources.ts';

const gunzip = promisify(zlib.gunzip);

const MB = 1 << 20;

/** Parsed source, manifests: what the indexer reads, so all an upload needs to carry. */
const SOURCE = `^(?!.*\\.d\\.ts$)(?!.*\\.min\\.js$).*(?:${SOURCE_EXTENSIONS.map((e) => e.replace(/[.+]/g, '\\$&')).join('|')})$`;

export const UPLOAD: UploadPolicy = {
  maxBytes: Math.max(1, Number(process.env.FIADA_UPLOAD_MB) || 50) * MB,
  maxFiles: 20_000,
  files: `${SOURCE}|${MANIFEST.source}`,
  skipDirs: [...IGNORED_DIR],
};

/**
 * Most bytes an archive for `policy` can take, compressed or not: the files,
 * plus tar's headers and padding (a long name adds a second header).
 */
export const archiveLimit = (policy: UploadPolicy) => policy.maxBytes + policy.maxFiles * 2048 + MB;

/** Something wrong with an upload that the person who sent it can fix; `status` is the HTTP code to answer with. */
export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const megabytes = (n: number) => `${Math.round(n / MB)} MB`;

export const tooBig = (policy: UploadPolicy) =>
  new UploadError(
    `This folder has more than ${megabytes(policy.maxBytes)} of source files, the upload limit. Upload a smaller folder, or add generated code to its .gitignore.`,
    413,
  );

export const tooMany = (policy: UploadPolicy) =>
  new UploadError(`This folder has more than ${policy.maxFiles.toLocaleString('en-US')} source files, the upload limit. Upload a smaller folder.`, 413);

const NOT_AN_ARCHIVE = new UploadError('The upload is not a gzipped tar archive. Pick the folder again in the map.');

export interface TarEntry {
  path: string;
  data: Buffer;
}

const text = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString('utf8');
};

function octal(field: Buffer): number {
  const s = text(field).trim();
  if (!/^[0-7]*$/.test(s)) throw NOT_AN_ARCHIVE;
  return s ? parseInt(s, 8) : 0;
}

/** A tar header's checksum: the sum of its bytes, with the checksum field read as spaces. */
function checksum(h: Buffer): number {
  let sum = 8 * 32;
  for (let i = 0; i < 512; i++) if (i < 148 || i >= 156) sum += h[i];
  return sum;
}

/** The `path` record of a pax extended header ("<length> path=<value>\n" records). */
function paxPath(data: Buffer): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < data.length; ) {
    const space = data.indexOf(0x20, i);
    const len = space < 0 ? NaN : parseInt(data.subarray(i, space).toString('ascii'), 10);
    if (!(len > 0)) break;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') found = record.slice(eq + 1);
    i += len;
  }
  return found;
}

/**
 * The regular files in a tar archive (ustar, with pax or GNU long names).
 * Directories, links and devices are skipped: an upload is plain files.
 */
export function* readTar(tar: Buffer): Generator<TarEntry> {
  let long: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) return; // end of archive
    if (octal(h.subarray(148, 156)) !== checksum(h)) throw NOT_AN_ARCHIVE;
    const size = octal(h.subarray(124, 136));
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const start = at + 512;
    if (start + size > tar.length) throw NOT_AN_ARCHIVE;
    const data = tar.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
    if (type === 'x') long = paxPath(data) ?? long;
    else if (type === 'L') long = text(data);
    else if (type !== 'g') {
      const prefix = h.subarray(257, 263).toString('latin1').startsWith('ustar') ? text(h.subarray(345, 500)) : '';
      const name = long ?? (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
      long = undefined;
      if (type === '0' || type === '7') yield { path: name, data };
    }
  }
}

/** A folder-relative path, or null when it could land outside the folder. */
export function safePath(name: string): string | null {
  const rel = name.replace(/^(\.\/)+/, '');
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  return parts.some((p) => !p || p === '.' || p === '..') ? null : rel;
}

/** What an upload's .git files say about where it came from. */
export interface GitMeta {
  /** The `origin` remote, without credentials. */
  remote?: string;
  branch?: string;
  /** Full commit id of HEAD. */
  head?: string;
}

/** The .git files the map sends: enough to name the remote and HEAD, none of the history. */
export const GIT_META = /^\.git\/(HEAD|config|packed-refs|refs\/heads\/.+)$/;

/** Drops the user and password from a URL; an scp-style `git@host:org/repo` has only a user name. */
export function withoutCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** Reads the remote, branch and HEAD out of a checkout's .git files, keyed like `.git/HEAD`. */
export function gitMeta(files: Map<string, string>): GitMeta {
  const meta: GitMeta = {};
  let section = '';
  for (const raw of (files.get('.git/config') ?? '').split('\n')) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) section = header[1].replace(/\s+/g, ' ').toLowerCase();
    else if (section === 'remote "origin"') {
      const url = /^url\s*=\s*"?([^"]*?)"?\s*$/i.exec(line)?.[1];
      if (url && url.length < 500) meta.remote = withoutCredentials(url);
    }
  }
  const head = (files.get('.git/HEAD') ?? '').trim();
  const ref = /^ref:\s*(refs\/heads\/(\S+))$/.exec(head);
  if (ref) {
    if (ref[2].length < 250) meta.branch = ref[2];
    const loose = files.get(`.git/${ref[1]}`)?.trim();
    const packed = (files.get('.git/packed-refs') ?? '').split('\n').find((l) => l.endsWith(` ${ref[1]}`))?.split(' ')[0];
    const id = loose || packed;
    if (id && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id)) meta.head = id;
  } else if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) meta.head = head;
  return meta;
}

export interface Unpacked {
  files: number;
  bytes: number;
  git: GitMeta;
}

/**
 * Unpacks an uploaded archive into `dest` (which must not exist yet),
 * keeping only the files `policy` asks for and never writing outside
 * `dest`. The .git files are read for their metadata, not written. Throws
 * UploadError when the archive is malformed or over the limits.
 */
export async function unpackUpload(archive: Buffer, dest: string, policy: UploadPolicy = UPLOAD): Promise<Unpacked> {
  let tar: Buffer;
  try {
    tar = await gunzip(archive, { maxOutputLength: archiveLimit(policy) });
  } catch (err) {
    throw (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? tooBig(policy) : NOT_AN_ARCHIVE;
  }
  const wanted = new RegExp(policy.files);
  const skip = new Set(policy.skipDirs);
  const git = new Map<string, string>();
  const keep: TarEntry[] = [];
  let bytes = 0;
  for (const entry of readTar(tar)) {
    const rel = safePath(entry.path);
    if (!rel) throw new UploadError(`The upload has a file outside its folder (${entry.path.slice(0, 120)}).`);
    if (GIT_META.test(rel)) {
      if (entry.data.length < MB) git.set(rel, entry.data.toString('utf8'));
      continue;
    }
    const dirs = rel.split('/').slice(0, -1);
    if (dirs.some((d) => skip.has(d))) continue;
    if (!rel.endsWith('/.gitignore') && rel !== '.gitignore' && !wanted.test(rel)) continue;
    bytes += entry.data.length;
    if (bytes > policy.maxBytes) throw tooBig(policy);
    if (keep.length >= policy.maxFiles) throw tooMany(policy);
    keep.push({ path: rel, data: entry.data });
  }
  if (!keep.some((f) => !f.path.endsWith('.gitignore'))) throw new UploadError('The upload has no source files the indexer reads (or its archive is empty).');
  await fs.mkdir(dest, { recursive: false });
  const made = new Set<string>();
  for (const f of keep) {
    const abs = path.join(dest, f.path);
    const dir = path.dirname(abs);
    if (!made.has(dir)) {
      await fs.mkdir(dir, { recursive: true }).catch((err: Error) => {
        throw new UploadError(`Couldn't unpack ${f.path}: ${err.message}`);
      });
      made.add(dir);
    }
    // A path listed twice is written twice, so the later one wins, as with tar itself.
    await fs.writeFile(abs, f.data).catch((err: Error) => {
      throw new UploadError(`Couldn't unpack ${f.path}: ${err.message}`);
    });
  }
  return { files: keep.length, bytes, git: gitMeta(git) };
}

/** A folder name fit to show and to derive an id from. */
export function folderName(raw: string): string {
  const name = raw.split(/[\\/]/).filter(Boolean).pop()?.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100);
  if (!name || name === '.' || name === '..') throw new UploadError('Name the uploaded folder with ?name=<folder name>.');
  return name;
}
