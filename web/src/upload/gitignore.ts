// .gitignore rules, enough to leave ignored files behind when a folder is
// uploaded. Where this reads a pattern differently from git, it keeps the
// file: the indexer unpacks uploads into a git repository of their own and
// applies the same .gitignore files again, so a file sent by mistake costs
// only its bytes, while one left out by mistake would be missing.

export interface IgnoreRule {
  /** Folder of the .gitignore the rule came from, relative to the uploaded folder ('' for its top). */
  base: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A gitignore glob as a regular expression body: `*` and `?` stop at `/`, `**` spans folders. */
function globBody(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*' && (i === 0 || p[i - 1] === '/') && (i + 2 === p.length || p[i + 2] === '/')) {
      if (i + 2 === p.length) {
        out += '.*'; // "dir/**": everything inside
        i += 1;
      } else {
        out += '(?:.*/)?'; // "**/" : any number of folders, none included
        i += 2;
      }
    } else if (c === '*') {
      while (p[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else {
        const set = p.slice(i + 1, end);
        out += `[${set.startsWith('!') ? `^${set.slice(1)}` : set}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < p.length) out += escape(p[++i]);
    else out += escape(c);
  }
  return out;
}

/** The rules of one .gitignore file found in folder `base`. */
export function parseGitignore(text: string, base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Trailing spaces don't count unless escaped.
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.replace(/\/+$/, '');
    if (!line) continue;
    // A slash anywhere but the end ties the pattern to this .gitignore's folder.
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    try {
      rules.push({ base, negate, dirOnly, re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globBody(line)}$`) });
    } catch {
      // A pattern this can't read ignores nothing.
    }
  }
  return rules;
}

/**
 * Whether `path` (relative to the uploaded folder) is ignored by `rules`,
 * listed from the top .gitignore down. The last rule that matches decides,
 * as in git. A file inside an ignored folder is never asked about: the walk
 * doesn't go into ignored folders, which is also why git can't re-include it.
 */
export function isIgnored(rules: IgnoreRule[], path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const rel = r.base ? (path.startsWith(`${r.base}/`) ? path.slice(r.base.length + 1) : null) : path;
    if (rel != null && r.re.test(rel)) ignored = !r.negate;
  }
  return ignored;
}
