// Loads tree-sitter grammars (prebuilt WASM) once and hands out parsers.

import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Lang } from '../model.ts';

export type SyntaxNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);
const WASM_DIR = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

const GRAMMAR: Record<Lang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};

let init: Promise<void> | null = null;
const parsers = new Map<Lang, Promise<Parser>>();

export function getParser(lang: Lang): Promise<Parser> {
  init ??= Parser.init();
  let p = parsers.get(lang);
  if (!p) {
    p = init.then(async () => {
      const language = await Parser.Language.load(path.join(WASM_DIR, GRAMMAR[lang]));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    });
    parsers.set(lang, p);
  }
  return p;
}

export const line = (n: SyntaxNode) => n.startPosition.row + 1;

/**
 * Best-effort literal value of a string-ish node, with interpolations
 * replaced by "{}". Returns null for anything that isn't a string.
 */
export function stringValue(n: SyntaxNode | null): string | null {
  if (!n) return null;
  switch (n.type) {
    case 'string': {
      // TS: string > string_fragment*. Python: string > string_start, string_content, interpolation, string_end.
      let out = '';
      let sawPart = false;
      for (const c of n.namedChildren) {
        if (c.type === 'string_fragment' || c.type === 'string_content' || c.type === 'escape_sequence') {
          out += c.text;
          sawPart = true;
        } else if (c.type === 'interpolation') {
          out += '{}';
          sawPart = true;
        }
      }
      if (sawPart) return out;
      // Empty string, or a grammar version that exposes no children.
      return n.text.replace(/^[a-zA-Z]*(['"]{1,3})([\s\S]*)\1$/, '$2');
    }
    case 'template_string': {
      let out = '';
      for (const c of n.namedChildren) {
        if (c.type === 'string_fragment' || c.type === 'escape_sequence') out += c.text;
        else if (c.type === 'template_substitution') out += '{}';
      }
      // Older grammars expose no string_fragment in templates; fall back to text.
      if (!n.namedChildren.some((c) => c.type === 'string_fragment')) {
        out = n.text.slice(1, -1).replace(/\$\{[^}]*\}/g, '{}');
      }
      return out;
    }
    case 'binary_expression': {
      // "/users/" + id
      const left = stringValue(n.childForFieldName('left'));
      if (left == null) return null;
      const right = stringValue(n.childForFieldName('right'));
      return left + (right ?? '{}');
    }
    case 'concatenated_string':
      return n.namedChildren.map((c) => stringValue(c) ?? '{}').join('');
    default:
      return null;
  }
}

/**
 * Turn whatever a client passed as a URL into a path we can match against
 * server routes, or null if it doesn't look like an HTTP path.
 */
export function toRequestPath(raw: string | null): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  const abs = s.match(/^https?:\/\/[^/]*(\/.*)?$/);
  if (abs) s = abs[1] ?? '/';
  // `${API_URL}/items` → "{}/items"
  while (s.startsWith('{}')) s = s.slice(2);
  if (!s.startsWith('/')) return null;
  s = s.split(/[?#]/)[0];
  if (!/[a-zA-Z]/.test(s)) return null;
  return s;
}

export const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
