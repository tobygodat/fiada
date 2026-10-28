// Language registry. Adding a language means: a grammar in treesitter.ts, an
// extension mapping here, and an extractor that fills a ParsedFile.

import type { HttpRequest, Lang, MountDecl, ParsedFile, RouteDecl, RouterDecl } from '../model.ts';
import { extractC, looksLikeCpp } from './cfamily.ts';
import { extractCSharp } from './csharp.ts';
import { extractGo } from './go.ts';
import { extractJava } from './java.ts';
import { extractKotlin } from './kotlin.ts';
import { extractPython } from './python.ts';
import { extractRuby } from './ruby.ts';
import { extractRust } from './rust.ts';
import { extractSwift } from './swift.ts';
import { getParser, type SyntaxNode } from './treesitter.ts';
import { extractTs } from './typescript.ts';

const EXT = new Map(Object.entries({
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx', // tsx grammar is a superset that handles JSX in plain JS
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c', // or C++: parseFile looks at the text
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hh': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.inl': 'cpp',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
} satisfies Record<string, Lang>));

const EXTRACT: Record<Lang, (root: SyntaxNode, file: ParsedFile) => void> = {
  typescript: extractTs,
  tsx: extractTs,
  javascript: extractTs,
  python: extractPython,
  go: extractGo,
  java: extractJava,
  kotlin: extractKotlin,
  csharp: extractCSharp,
  rust: extractRust,
  c: extractC,
  cpp: extractC,
  ruby: extractRuby,
  swift: extractSwift,
};

/** Extensions of the files a language here parses. */
export const SOURCE_EXTENSIONS = [...EXT.keys()];

export function langOf(path: string): Lang | null {
  if (path.endsWith('.d.ts')) return null;
  const dot = path.lastIndexOf('.');

  return dot < 0 ? null : (EXT.get(path.slice(dot)) ?? null);
}

export async function parseFile(path: string, text: string): Promise<ParsedFile | null> {
  let lang = langOf(path);

  if (!lang) return null;

  if (lang === 'c' && path.endsWith('.h') && looksLikeCpp(text)) lang = 'cpp';
  const parser = await getParser(lang);
  const tree = parser.parse(text);

  const file: ParsedFile = {
    path,
    lang,
    loc: text.split('\n').length,
    imports: [],
    symbols: [],
    fileRefs: [],
    routes: [],
    requests: [],
    routers: [],
    mounts: [],
    constants: [],
    pages: [],
    localExports: [],
    jsx: false,
    code: {},
  };

  try {
    EXTRACT[lang](tree.rootNode, file);

    if (tree.rootNode.hasError()) file.partial = true;
  } finally {
    tree.delete();
  }

  keepEvidenceLines(file, text);

  return file;
}

/** Keep the text of every line an edge might cite, so the contract panel can show code without reading files. */
function keepEvidenceLines(file: ParsedFile, text: string) {
  const want = new Set<number>();
  const add = (l: number | undefined) => l && want.add(l);

  for (const i of file.imports) add(i.line);

  for (const r of file.fileRefs) add(r.line);

  const decls = (x: { routes?: RouteDecl[]; requests?: HttpRequest[]; mounts?: MountDecl[]; routers?: RouterDecl[] }) => {
    for (const r of x.routes ?? []) (add(r.line), add(r.prefixLine));

    for (const r of x.requests ?? []) add(r.line);

    for (const m of x.mounts ?? []) add(m.line);

    for (const r of x.routers ?? []) add(r.line);
  };

  decls(file);

  for (const c of file.constants) add(c.line);

  for (const c of file.clients ?? []) add(c.line);

  for (const s of file.symbols) {
    add(s.lines[0]);

    for (const r of s.refs) add(r.line);

    for (const i of s.imports ?? []) add(i.line);

    for (const o of s.orm ?? []) add(o.line);
    add(s.clientBase?.line);
    decls(s);
  }

  if (!want.size) return;
  const lines = text.split('\n');

  for (const l of want) {
    const t = lines[l - 1]?.trim();

    if (t) file.code[l] = t.length > 200 ? t.slice(0, 199) + '…' : t;
  }
}
