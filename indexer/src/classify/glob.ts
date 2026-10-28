/**
 * Minimal glob: `**` spans directories, `*` stays within one, `?` is one
 * character, `[A-Z]` is a character class. A glob that names a directory also
 * matches everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
      const end = glob.indexOf(']', i + 2);
      re += `[${glob.slice(i + 1, end).replace(/[\\\]]/g, '\\$&')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${re}(?:/.*)?$`);
}

const cache = new Map<string, RegExp>();

export function globMatch(glob: string, path: string): boolean {
  let re = cache.get(glob);

  if (!re) cache.set(glob, (re = globToRegExp(glob)));

  return re.test(path);
}
