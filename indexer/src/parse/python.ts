// Python fact extraction.

import type { SymbolKind } from '@strata/shared';
import type { HttpRequest, ImportSpec, ParsedFile, RouteDecl } from '../model.ts';
import { RefSet } from './refs.ts';
import { HTTP_VERBS, line, stringValue, toRequestPath, type SyntaxNode } from './treesitter.ts';

const ROUTE_ATTRS = new Set([...HTTP_VERBS, 'route', 'api_route', 'websocket']);
const ENUM_BASES = /(^|\.)(Enum|IntEnum|StrEnum|Flag|IntFlag)$/;
const INTERFACE_BASES = /(^|\.)(Protocol|TypedDict|ABC)$/;

function parseImport(n: SyntaxNode): ImportSpec[] {
  if (n.type === 'import_statement') {
    // import a.b, c as d
    const out: ImportSpec[] = [];
    for (const c of n.namedChildren) {
      if (c.type === 'dotted_name') out.push({ source: c.text, level: 0, names: [{ imported: '*', local: c.text.split('.')[0] }], line: line(n) });
      else if (c.type === 'aliased_import') {
        const name = c.childForFieldName('name')?.text;
        const alias = c.childForFieldName('alias')?.text;
        if (name && alias) out.push({ source: name, level: 0, names: [{ imported: '*', local: alias }], line: line(n) });
      }
    }
    return out;
  }
  // from x import a, b as c   /   from . import a   /   from x import *
  const mod = n.childForFieldName('module_name');
  if (!mod) return [];
  let source = mod.text;
  let level = 0;
  if (mod.type === 'relative_import') {
    const prefix = mod.namedChildren.find((c) => c.type === 'import_prefix')?.text ?? '';
    level = prefix.length;
    source = mod.namedChildren.find((c) => c.type === 'dotted_name')?.text ?? '';
  }
  const spec: ImportSpec = { source, level, names: [], line: line(n) };
  for (const c of n.namedChildren) {
    if (c.id === mod.id) continue;
    if (c.type === 'dotted_name') spec.names.push({ imported: c.text, local: c.text });
    else if (c.type === 'aliased_import') {
      const name = c.childForFieldName('name')?.text;
      const alias = c.childForFieldName('alias')?.text;
      if (name) spec.names.push({ imported: name, local: alias ?? name });
    } else if (c.type === 'wildcard_import') spec.reexportAll = true;
  }
  return [spec];
}

interface Scan {
  refs: RefSet;
  requests: HttpRequest[];
}

function scan(node: SyntaxNode, self?: string): Scan {
  const refs = new RefSet(self);
  const requests: HttpRequest[] = [];
  const memberObjects = new Set<number>();
  const typeIds = new Set<number>();

  for (const t of node.descendantsOfType('type')) {
    for (const id of t.descendantsOfType('identifier')) typeIds.add(id.id);
  }
  for (const n of node.descendantsOfType(['call', 'identifier'])) {
    if (n.type === 'call') {
      const fn = n.childForFieldName('function');
      if (fn?.type === 'identifier') refs.add(fn.text, 'call');
      else if (fn?.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        const attr = fn.childForFieldName('attribute')?.text;
        if (obj?.type === 'identifier' && attr) {
          refs.add(obj.text, 'call', attr);
          memberObjects.add(obj.id);
          // `@router.get("/x")` is a route, not a request.
          if (HTTP_VERBS.has(attr) && n.parent?.type !== 'decorator') {
            const path = toRequestPath(stringValue(n.childForFieldName('arguments')?.namedChildren[0] ?? null));
            if (path) requests.push({ method: attr.toUpperCase(), path, line: line(n) });
          }
        }
      }
    } else if (!memberObjects.has(n.id) && !isNameSlot(n)) {
      refs.add(n.text, typeIds.has(n.id) ? 'type' : 'ref');
    }
  }
  return { refs, requests };
}

/** Identifiers that name an attribute or keyword rather than referring to anything. */
function isNameSlot(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  if (p.type === 'attribute') return p.childForFieldName('attribute')?.id === n.id;
  if (p.type === 'keyword_argument') return p.childForFieldName('name')?.id === n.id;
  return false;
}

/** `router = APIRouter(prefix="/items")` or `bp = Blueprint("x", __name__, url_prefix="/x")`. */
function routerPrefix(assign: SyntaxNode): [string, string] | null {
  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');
  if (left?.type !== 'identifier' || right?.type !== 'call') return null;
  for (const arg of right.childForFieldName('arguments')?.namedChildren ?? []) {
    if (arg.type !== 'keyword_argument') continue;
    const key = arg.childForFieldName('name')?.text;
    if (key === 'prefix' || key === 'url_prefix') {
      const v = stringValue(arg.childForFieldName('value'));
      if (v != null) return [left.text, v];
    }
  }
  return null;
}

function routeFromDecorator(dec: SyntaxNode, prefixes: Map<string, string>): RouteDecl | null {
  const call = dec.namedChildren.find((c) => c.type === 'call');
  const fn = call?.childForFieldName('function');
  if (!call || fn?.type !== 'attribute') return null;
  const obj = fn.childForFieldName('object')?.text ?? '';
  const attr = fn.childForFieldName('attribute')?.text ?? '';
  if (!ROUTE_ATTRS.has(attr)) return null;
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  const path = stringValue(args.find((a) => a.type !== 'keyword_argument') ?? null);
  if (path == null) return null;
  let method = HTTP_VERBS.has(attr) ? attr.toUpperCase() : attr === 'websocket' ? 'WS' : '*';
  for (const a of args) {
    if (a.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'methods') {
      const first = a.childForFieldName('value')?.namedChildren[0];
      const m = stringValue(first ?? null);
      if (m) method = m.toUpperCase();
    }
  }
  if (method === '*' && attr === 'route') method = 'GET';
  return { method, path: joinPath(prefixes.get(obj) ?? '', path), line: line(call) };
}

const joinPath = (a: string, b: string) => (a.replace(/\/$/, '') + '/' + b.replace(/^\//, '')).replace(/\/+/g, '/');

export function extractPython(root: SyntaxNode, file: ParsedFile) {
  const fileRefs = new RefSet();
  const prefixes = new Map<string, string>();

  // Router prefixes first: decorators below refer to them.
  for (const n of root.namedChildren) {
    if (n.type !== 'expression_statement') continue;
    const assign = n.namedChildren.find((c) => c.type === 'assignment');
    const p = assign && routerPrefix(assign);
    if (p) prefixes.set(p[0], p[1]);
  }

  const visit = (n: SyntaxNode) => {
    switch (n.type) {
      case 'import_statement':
      case 'import_from_statement':
      case 'future_import_statement':
        file.imports.push(...parseImport(n));
        return;
      case 'decorated_definition':
      case 'function_definition':
      case 'class_definition': {
        const def = n.type === 'decorated_definition' ? n.childForFieldName('definition') : n;
        if (!def) return;
        const name = def.childForFieldName('name')?.text;
        if (!name) return;
        const decorators: string[] = [];
        const routes: RouteDecl[] = [];
        if (n.type === 'decorated_definition') {
          for (const d of n.namedChildren) {
            if (d.type !== 'decorator') continue;
            const expr = d.namedChildren[0];
            decorators.push((expr?.type === 'call' ? expr.childForFieldName('function')?.text : expr?.text) ?? '');
            const r = routeFromDecorator(d, prefixes);
            if (r) routes.push(r);
          }
        }
        let kind: SymbolKind = def.type === 'class_definition' ? 'class' : 'function';
        let bases: string[] | undefined;
        if (def.type === 'class_definition') {
          // Keep keyword arguments too ("table=True" marks a SQLModel table).
          bases = (def.childForFieldName('superclasses')?.namedChildren ?? [])
            .filter((b) => b.type === 'identifier' || b.type === 'attribute' || b.type === 'keyword_argument')
            .map((b) => b.text.replace(/\s+/g, ''));
          if (bases.some((b) => ENUM_BASES.test(b))) kind = 'enum';
          else if (bases.some((b) => INTERFACE_BASES.test(b))) kind = 'interface';
        }
        const s = scan(n, name);
        for (const b of bases ?? []) if (/^[A-Za-z_]\w*$/.test(b)) s.refs.add(b, 'type');
        file.symbols.push({
          name,
          kind,
          exported: !name.startsWith('_'),
          lines: [line(n), n.endPosition.row + 1],
          refs: s.refs.list(),
          bases: bases?.length ? bases : undefined,
          decorators: decorators.length ? decorators : undefined,
          routes: routes.length ? routes : undefined,
          requests: s.requests.length ? s.requests : undefined,
        });
        return;
      }
      case 'if_statement':
      case 'try_statement':
      case 'with_statement': {
        // Conditional imports (`try: import x`) still count; everything else is module-level code.
        for (const imp of n.descendantsOfType(['import_statement', 'import_from_statement'])) file.imports.push(...parseImport(imp));
        mergeInto(fileRefs, scan(n), file);
        return;
      }
      case 'comment':
        return;
      default:
        mergeInto(fileRefs, scan(n), file);
    }
  };

  for (const n of root.namedChildren) visit(n);
  file.fileRefs = fileRefs.list();
}

function mergeInto(into: RefSet, s: Scan, file: ParsedFile) {
  for (const r of s.refs.list()) into.add(r.name, r.kind, r.member);
  file.requests.push(...s.requests);
}
