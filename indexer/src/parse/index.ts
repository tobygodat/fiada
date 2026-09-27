// Language registry. Adding a language means: a grammar in treesitter.ts, an
// extension mapping here, and an extractor that fills a ParsedFile.

import type { Lang, ParsedFile } from '../model.ts';
import { extractPython } from './python.ts';
import { getParser, type SyntaxNode } from './treesitter.ts';
import { extractTs } from './typescript.ts';

const EXT: Record<string, Lang> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx', // tsx grammar is a superset that handles JSX in plain JS
  '.py': 'python',
};

const EXTRACT: Record<Lang, (root: SyntaxNode, file: ParsedFile) => void> = {
  typescript: extractTs,
  tsx: extractTs,
  javascript: extractTs,
  python: extractPython,
};

export function langOf(path: string): Lang | null {
  if (path.endsWith('.d.ts')) return null;
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : (EXT[path.slice(dot)] ?? null);
}

export async function parseFile(path: string, text: string): Promise<ParsedFile | null> {
  const lang = langOf(path);
  if (!lang) return null;
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
    localExports: [],
    jsx: false,
  };
  try {
    EXTRACT[lang](tree.rootNode, file);
    if (tree.rootNode.hasError()) file.partial = true;
  } finally {
    tree.delete();
  }
  return file;
}
