// Loads tree-sitter grammars (prebuilt WASM) once and hands out parsers.

import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Lang, UrlPart } from '../model.ts';

export type SyntaxNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);
const WASM_DIR = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

const GRAMMAR: Record<Lang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  rust: 'tree-sitter-rust.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
};

/**
 * C functions a grammar's scanner calls that this build of web-tree-sitter
 * doesn't export. Ruby's scanner needs `iswupper`; without it parsing throws.
 */
const LIBC = {
  _iswupper: (c: number) => {
    const s = String.fromCodePoint(c);
    return s !== s.toLowerCase() && s === s.toUpperCase() ? 1 : 0;
  },
};

let init: Promise<void> | null = null;
const parsers = new Map<Lang, Promise<Parser>>();

export function getParser(lang: Lang): Promise<Parser> {
  init ??= Parser.init(LIBC);
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

/** Every child in a field that repeats (Go's `a, b := …` names), which this grammar version only exposes through a cursor. */
export function fieldChildren(n: SyntaxNode, field: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const c = n.walk();
  try {
    if (c.gotoFirstChild()) {
      do {
        if (c.currentFieldName() === field) out.push(c.currentNode());
      } while (c.gotoNextSibling());
    }
  } finally {
    c.delete();
  }
  return out;
}

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
    case 'interpreted_string_literal':
    case 'raw_string_literal':
      // Go: "…" or `…`
      return n.text.slice(1, -1);
    default:
      return null;
  }
}

/** Source line of a node, trimmed, for evidence. */
export const lineText = (n: SyntaxNode) => n.text.split('\n')[0].trim().slice(0, 200);

/**
 * Literal text and interpolated expressions of a string-ish node, in order.
 * With `exprs`, a bare identifier or member access counts as one expression
 * part (a prefix given as `settings.API_V1_STR`). Null when it isn't a string.
 */
export function urlParts(n: SyntaxNode | null, exprs = false): UrlPart[] | null {
  if (!n) return null;
  const inner = (c: SyntaxNode) => (c.namedChildren[0] ?? c).text;
  switch (n.type) {
    case 'string': {
      const parts: UrlPart[] = [];
      for (const c of n.namedChildren) {
        if (c.type === 'string_fragment' || c.type === 'string_content' || c.type === 'escape_sequence') parts.push({ lit: c.text });
        else if (c.type === 'interpolation') parts.push({ expr: inner(c) });
      }
      if (parts.length) return merge(parts);
      const v = stringValue(n);
      return v == null ? null : [{ lit: v }];
    }
    case 'template_string': {
      if (!n.namedChildren.some((c) => c.type === 'string_fragment')) {
        // Older grammars: split the raw text on ${…}.
        const parts: UrlPart[] = [];
        const raw = n.text.slice(1, -1);
        let last = 0;
        for (const m of raw.matchAll(/\$\{([^}]*)\}/g)) {
          if (m.index! > last) parts.push({ lit: raw.slice(last, m.index) });
          parts.push({ expr: m[1].trim() });
          last = m.index! + m[0].length;
        }
        if (last < raw.length) parts.push({ lit: raw.slice(last) });
        return merge(parts);
      }
      const parts: UrlPart[] = [];
      for (const c of n.namedChildren) {
        if (c.type === 'string_fragment' || c.type === 'escape_sequence') parts.push({ lit: c.text });
        else if (c.type === 'template_substitution') parts.push({ expr: inner(c) });
      }
      return merge(parts);
    }
    case 'binary_expression': {
      const left = urlParts(n.childForFieldName('left'), true);
      const right = urlParts(n.childForFieldName('right'), true);
      if (!left || !right) return null;
      if (!left.some((p) => 'lit' in p) && !right.some((p) => 'lit' in p) && !exprs) return null;
      return merge([...left, ...right]);
    }
    case 'concatenated_string':
      return merge(n.namedChildren.flatMap((c) => urlParts(c) ?? [{ expr: c.text }]));
    case 'interpreted_string_literal':
    case 'raw_string_literal':
      return [{ lit: n.text.slice(1, -1) }];
    case 'identifier':
    case 'member_expression':
    case 'attribute':
    case 'selector_expression':
      return exprs ? [{ expr: n.text }] : null;
    default:
      return null;
  }
}

function merge(parts: UrlPart[]): UrlPart[] {
  const out: UrlPart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if ('lit' in p && prev && 'lit' in prev) prev.lit += p.lit;
    else out.push({ ...p });
  }
  return out;
}

/** Parts joined back into a string, with every expression as "{}". */
export const partsText = (parts: UrlPart[]) => parts.map((p) => ('lit' in p ? p.lit : '{}')).join('');

/** A client request's path, plus the expression it started with if that was stripped as a base URL. */
export function requestUrl(n: SyntaxNode | null): { path: string; base?: string } | null {
  const parts = urlParts(n);
  if (!parts) return null;
  const path = toRequestPath(partsText(parts));
  if (!path) return null;
  const first = parts[0];
  return first && 'expr' in first ? { path, base: first.expr } : { path };
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
