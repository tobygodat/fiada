// Rust fact extraction: `use` paths and `mod` declarations, structs, enums,
// traits, functions and the methods of `impl` blocks (as "Type.method"), and
// the routes of actix-web and Rocket attributes (`#[get("/x")]`).

import type { ImportSpec, ParsedFile, RouteDecl } from '../model.ts';
import { capitalized, enclosingFunction, literal, outline, type Decl, type LangSpec } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const ITEM_KIND = {
  struct_item: 'class',
  union_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  type_item: 'type',
  function_item: 'function',
  function_signature_item: 'function',
  const_item: 'variable',
  static_item: 'variable',
  macro_definition: 'function',
} as const;

const ROUTE_ATTR: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', head: 'HEAD', options: 'OPTIONS' };

const isPub = (n: SyntaxNode) => n.namedChildren.some((c) => c.type === 'visibility_modifier');

/** `Foo`, `Foo<T>`, `crate::a::Foo` → "Foo". */
const typeName = (n: SyntaxNode | null | undefined): string | null => {
  if (!n) return null;
  if (n.type === 'type_identifier') return n.text;
  if (n.type === 'generic_type') return typeName(n.childForFieldName('type'));
  if (n.type === 'scoped_type_identifier') return n.childForFieldName('name')?.text ?? null;
  return null;
};

/** `#[get("/items/{id}")]` attributes just above an item. */
function attributeRoutes(n: SyntaxNode): RouteDecl[] {
  const out: RouteDecl[] = [];
  for (let p = n.previousNamedSibling; p?.type === 'attribute_item'; p = p.previousNamedSibling) {
    const attr = p.namedChildren[0];
    const name = attr?.namedChildren[0]?.text ?? '';
    const verb = ROUTE_ATTR[name.slice(name.lastIndexOf(':') + 1)];
    const path = literal(attr?.descendantsOfType('string_literal')[0]);
    if (verb && path != null) out.push({ method: verb, path, line: line(p) });
  }
  return out;
}

/** Every path a `use` declaration brings in, with its alias, expanding `{…}` lists. */
function usePaths(n: SyntaxNode | null, prefix: string, out: { path: string; alias?: string; glob?: boolean }[]) {
  if (!n) return;
  const join = (a: string, b: string) => (a ? `${a}::${b}` : b);
  switch (n.type) {
    case 'scoped_use_list':
      for (const c of n.childForFieldName('list')?.namedChildren ?? []) usePaths(c, join(prefix, n.childForFieldName('path')?.text ?? ''), out);
      return;
    case 'use_list':
      for (const c of n.namedChildren) usePaths(c, prefix, out);
      return;
    case 'use_as_clause':
      out.push({ path: join(prefix, n.childForFieldName('path')?.text ?? ''), alias: n.childForFieldName('alias')?.text });
      return;
    case 'use_wildcard':
      out.push({ path: join(prefix, n.namedChildren[0]?.text ?? ''), glob: true });
      return;
    case 'self':
      out.push({ path: prefix });
      return;
    default:
      out.push({ path: join(prefix, n.text) });
  }
}

function imports(root: SyntaxNode): ImportSpec[] {
  const out: ImportSpec[] = [];
  for (const u of root.descendantsOfType('use_declaration')) {
    const paths: { path: string; alias?: string; glob?: boolean }[] = [];
    usePaths(u.childForFieldName('argument'), '', paths);
    for (const p of paths) {
      if (p.glob) out.push({ source: p.path, level: 0, names: [], open: true, line: line(u) });
      else {
        const last = p.path.slice(p.path.lastIndexOf(':') + 1);
        out.push({ source: p.path, level: 0, names: [{ imported: last, local: p.alias ?? last }], line: line(u) });
      }
    }
  }
  // `mod routes;` pulls in routes.rs or routes/mod.rs.
  for (const m of root.descendantsOfType('mod_item')) {
    const name = m.childForFieldName('name')?.text;
    if (name && !m.childForFieldName('body')) out.push({ source: `self::${name}`, level: 0, names: [], line: line(m) });
  }
  return out;
}

const spec: LangSpec = {
  decl(n, owner): Decl | null {
    if (n.type === 'use_declaration' || n.type === 'attribute_item' || n.type === 'inner_attribute_item') return { as: 'skip' };
    // An inline `mod a { … }` names what it declares "a.Item", as a type names its methods.
    const within = (name: string | null | undefined) => (name ? (owner ? `${owner}.${name}` : name) : undefined);
    if (n.type === 'mod_item') {
      const body = n.childForFieldName('body');
      return body ? { as: 'scope', body, owner: within(n.childForFieldName('name')?.text) } : { as: 'skip' };
    }
    if (n.type === 'impl_item') return { as: 'scope', body: n.childForFieldName('body'), owner: within(typeName(n.childForFieldName('type'))) };
    if (n.type in ITEM_KIND) {
      const name = n.childForFieldName('name')?.text;
      if (!name) return null;
      const kind = ITEM_KIND[n.type as keyof typeof ITEM_KIND];
      const as = kind === 'function' ? 'function' : kind === 'variable' ? 'variable' : 'type';
      return { as, kind, name, body: n.childForFieldName('body'), exported: isPub(n), routes: as === 'function' ? attributeRoutes(n) : undefined };
    }
    return null;
  },
  ref(n, out) {
    switch (n.type) {
      case 'call_expression': {
        let fn = n.childForFieldName('function');
        if (fn?.type === 'generic_function') fn = fn.childForFieldName('function');
        if (!fn) return;
        if (fn.type === 'identifier') {
          out.seen(fn);
          out.add(fn.text, 'call', n);
        } else if (fn.type === 'scoped_identifier') {
          const path = fn.childForFieldName('path');
          const name = fn.childForFieldName('name')?.text;
          const owner = path?.type === 'generic_type' ? typeName(path) : path?.type === 'identifier' ? path.text : null;
          if (!name) return;
          out.seen(fn);
          out.seen(path);
          if (owner) out.add(owner, name === 'new' ? 'new' : 'call', n, name);
          else if (path?.type === 'self' || path?.type === 'crate' || path?.type === 'super') out.add(name, 'call', n);
        } else if (fn.type === 'field_expression') {
          const value = fn.childForFieldName('value');
          const field = fn.childForFieldName('field')?.text;
          out.seen(fn);
          if (value?.type === 'self' && field) out.self(field, 'call', n);
        }
        return;
      }
      case 'struct_expression': {
        const name = typeName(n.childForFieldName('name'));
        out.seen(n.childForFieldName('name'));
        if (name) out.add(name, 'new', n);
        return;
      }
      case 'macro_invocation': {
        const m = n.childForFieldName('macro');
        if (m?.type === 'identifier') {
          out.seen(m);
          out.add(m.text, 'call', n);
        }
        return;
      }
      case 'scoped_identifier': {
        const path = n.childForFieldName('path');
        const name = n.childForFieldName('name')?.text;
        if (path?.type === 'identifier' && name) out.add(path.text, 'ref', n, name);
        return true;
      }
      case 'scoped_type_identifier': {
        const path = n.childForFieldName('path');
        const name = n.childForFieldName('name')?.text;
        if (path?.type === 'identifier' && name) out.add(path.text, 'type', n, name);
        return true;
      }
      case 'field_expression':
        if (n.childForFieldName('value')?.type === 'self') {
          const field = n.childForFieldName('field')?.text;
          if (field) out.self(field, 'ref', n);
        }
        return;
      case 'type_identifier':
        out.add(n.text, 'type', n);
        return;
      case 'identifier':
        if (capitalized(n.text)) out.add(n.text, 'ref', n);
        return;
    }
  },
};

export function extractRust(root: SyntaxNode, file: ParsedFile) {
  const specs = imports(root);
  outline(root, spec, file);
  // A `use` inside a function binds only there.
  for (const s of specs) {
    const owner = enclosingFunction(file, s.line);
    if (owner) (owner.imports ??= []).push(s);
    else file.imports.push(s);
  }
  // `impl Api for Service` makes Api a base of Service, when both are here.
  for (const impl of root.descendantsOfType('impl_item')) {
    const trait = typeName(impl.childForFieldName('trait'));
    const owner = typeName(impl.childForFieldName('type'));
    const sym = owner ? file.symbols.find((s) => (s.name === owner || s.name.endsWith(`.${owner}`)) && s.kind !== 'function') : undefined;
    if (trait && sym) sym.bases = [...(sym.bases ?? []), trait];
  }
}
