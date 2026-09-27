// TypeScript / TSX / JavaScript fact extraction.

import type { SymbolKind } from '@strata/shared';
import type { HttpRequest, ImportSpec, ParsedFile, ParsedSymbol, RouteDecl } from '../model.ts';
import { RefSet } from './refs.ts';
import { HTTP_VERBS, line, stringValue, toRequestPath, type SyntaxNode } from './treesitter.ts';

const FETCH_FNS = new Set(['fetch', '$fetch', 'ofetch', 'ky', 'useSWR', 'useFetch', 'request']);
const ROUTER_OBJECT = /^(app|router|server|fastify|hono|r|routes)$|Router$|router$|App$/;
const FUNCTION_LIKE = new Set(['arrow_function', 'function', 'function_expression', 'generator_function']);
const JSX_TYPES = ['jsx_element', 'jsx_self_closing_element', 'jsx_fragment'];

const isPascal = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s);

interface Scan {
  refs: RefSet;
  jsx: boolean;
  routes: RouteDecl[];
  requests: HttpRequest[];
}

/** Collect refs, routes and requests from everything under `node`. */
function scan(node: SyntaxNode, self?: string): Scan {
  const refs = new RefSet(self);
  const routes: RouteDecl[] = [];
  const requests: HttpRequest[] = [];
  const memberObjects = new Set<number>();

  const nodes = node.descendantsOfType([
    'call_expression',
    'new_expression',
    'jsx_opening_element',
    'jsx_self_closing_element',
    'type_identifier',
    'nested_type_identifier',
    'identifier',
    'object',
  ]);
  // descendantsOfType excludes the node itself.
  if (node.type === 'call_expression' || node.type === 'object' || node.type === 'new_expression') nodes.unshift(node);

  let jsx = false;
  for (const n of nodes) {
    switch (n.type) {
      case 'call_expression': {
        const fn = n.childForFieldName('function');
        if (!fn) break;
        if (fn.type === 'identifier') refs.add(fn.text, 'call');
        else if (fn.type === 'member_expression') {
          const obj = fn.childForFieldName('object');
          const prop = fn.childForFieldName('property');
          if (obj?.type === 'identifier' && prop) {
            refs.add(obj.text, 'call', prop.text);
            memberObjects.add(obj.id);
          }
        }
        httpFromCall(n, fn, routes, requests);
        break;
      }
      case 'new_expression': {
        const ctor = n.childForFieldName('constructor');
        if (ctor?.type === 'identifier') refs.add(ctor.text, 'new');
        break;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        jsx = true;
        const name = n.childForFieldName('name');
        if (!name) break;
        if (name.type === 'identifier' && isPascal(name.text)) refs.add(name.text, 'jsx');
        else if (name.type === 'member_expression' || name.type === 'nested_identifier') {
          const [obj, prop] = name.text.split('.');
          if (obj && prop) refs.add(obj, 'jsx', prop);
          const first = name.firstNamedChild;
          if (first?.type === 'identifier') memberObjects.add(first.id);
        }
        break;
      }
      case 'type_identifier':
        refs.add(n.text, 'type');
        break;
      case 'nested_type_identifier': {
        const [obj, prop] = n.text.split('.');
        if (obj && prop) refs.add(obj, 'type', prop);
        break;
      }
      case 'identifier':
        if (!memberObjects.has(n.id)) refs.add(n.text, 'ref');
        break;
      case 'object':
        requestFromObject(n, requests);
        break;
    }
  }
  if (!jsx && node.descendantsOfType(JSX_TYPES).length) jsx = true;
  return { refs, jsx, routes, requests };
}

function httpFromCall(call: SyntaxNode, fn: SyntaxNode, routes: RouteDecl[], requests: HttpRequest[]) {
  const args = call.childForFieldName('arguments');
  if (!args) return;
  const argv = args.namedChildren;
  if (!argv.length) return;
  const first = stringValue(argv[0]);

  if (fn.type === 'identifier' && FETCH_FNS.has(fn.text)) {
    const path = toRequestPath(first);
    if (path) requests.push({ method: methodFromOptions(argv[1]) ?? 'GET', path, line: line(call) });
    return;
  }
  if (fn.type !== 'member_expression') return;
  const obj = fn.childForFieldName('object');
  const verb = fn.childForFieldName('property')?.text ?? '';
  if (!HTTP_VERBS.has(verb) && verb !== 'all' && verb !== 'request') return;

  const last = argv[argv.length - 1];
  const handlerLike = argv.length >= 2 && (FUNCTION_LIKE.has(last.type) || last.type === 'identifier' || last.type === 'member_expression');
  const routerish = obj != null && ROUTER_OBJECT.test(obj.text.split('.').pop() ?? '');
  if (first?.startsWith('/') && handlerLike && (routerish || FUNCTION_LIKE.has(last.type))) {
    routes.push({ method: verb === 'all' ? '*' : verb.toUpperCase(), path: first, line: line(call) });
    return;
  }
  const method = HTTP_VERBS.has(verb) ? verb.toUpperCase() : (methodFromOptions(argv[1]) ?? 'GET');
  // client.get("/items") or client.get({ url: "/items" }) as generated SDKs do.
  const path = toRequestPath(first) ?? (argv[0].type === 'object' ? urlFromOptions(argv[0]) : null);
  if (path) requests.push({ method, path, line: line(call) });
}

function urlFromOptions(opts: SyntaxNode): string | null {
  for (const pair of opts.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
    if (key === 'url' || key === 'path') return toRequestPath(stringValue(pair.childForFieldName('value')));
  }
  return null;
}

function methodFromOptions(opts: SyntaxNode | undefined): string | null {
  if (!opts || opts.type !== 'object') return null;
  for (const pair of opts.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
    if (key === 'method') return stringValue(pair.childForFieldName('value'))?.toUpperCase() ?? null;
  }
  return null;
}

/** `{ method: "GET", url: "/api/v1/items/" }`, the shape generated OpenAPI clients use. */
function requestFromObject(obj: SyntaxNode, requests: HttpRequest[]) {
  let method: string | null = null;
  let url: string | null = null;
  for (const pair of obj.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
    if (key === 'method') method = stringValue(pair.childForFieldName('value'));
    else if (key === 'url') url = toRequestPath(stringValue(pair.childForFieldName('value')));
  }
  if (method && url) requests.push({ method: method.toUpperCase(), path: url, line: line(obj) });
}

function parseImport(n: SyntaxNode): ImportSpec | null {
  const source = stringValue(n.childForFieldName('source'));
  if (source == null) return null;
  const spec: ImportSpec = { source, level: 0, names: [], line: line(n) };
  const clause = n.namedChildren.find((c) => c.type === 'import_clause');
  for (const c of clause?.namedChildren ?? []) {
    if (c.type === 'identifier') spec.names.push({ imported: 'default', local: c.text });
    else if (c.type === 'namespace_import') {
      const id = c.namedChildren.find((x) => x.type === 'identifier');
      if (id) spec.names.push({ imported: '*', local: id.text });
    } else if (c.type === 'named_imports') {
      for (const s of c.namedChildren) {
        if (s.type !== 'import_specifier') continue;
        const name = s.childForFieldName('name')?.text;
        const alias = s.childForFieldName('alias')?.text;
        if (name) spec.names.push({ imported: name, local: alias ?? name });
      }
    }
  }
  return spec;
}

/** `require("x")` and `import("x")` at any depth. */
function dynamicImports(root: SyntaxNode): ImportSpec[] {
  const out: ImportSpec[] = [];
  for (const call of root.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || !(fn.text === 'require' || fn.type === 'import')) continue;
    const arg = call.childForFieldName('arguments')?.namedChildren[0];
    const source = stringValue(arg ?? null);
    if (source == null) continue;
    // `const x = require("y")` binds x to the whole module.
    const decl = call.parent?.type === 'variable_declarator' ? call.parent : null;
    const name = decl?.childForFieldName('name');
    const names = name?.type === 'identifier' ? [{ imported: '*', local: name.text }] : [];
    out.push({ source, level: 0, names, line: line(call) });
  }
  return out;
}

export function extractTs(root: SyntaxNode, file: ParsedFile) {
  const fileScan = new RefSet();
  const addSymbol = (s: ParsedSymbol) => file.symbols.push(s);

  const symbolFrom = (decl: SyntaxNode, exported: boolean, isDefault: boolean) => {
    const lines: [number, number] = [line(decl), decl.endPosition.row + 1];
    const named = (name: string, kind: SymbolKind, body: SyntaxNode, extra: Partial<ParsedSymbol> = {}) => {
      const s = scan(body, name);
      if (kind === 'function' && s.jsx && isPascal(name)) kind = 'component';
      addSymbol({
        name,
        kind,
        exported,
        isDefault,
        lines,
        refs: s.refs.list(),
        jsx: s.jsx,
        routes: s.routes.length ? s.routes : undefined,
        requests: s.requests.length ? s.requests : undefined,
        ...extra,
      });
    };

    switch (decl.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function':
      case 'function_expression':
      case 'arrow_function': {
        const name = decl.childForFieldName('name')?.text ?? 'default';
        named(name, 'function', decl);
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = decl.childForFieldName('name')?.text ?? 'default';
        const heritage = decl.namedChildren.find((c) => c.type === 'class_heritage');
        const bases = heritage
          ? heritage.descendantsOfType(['identifier', 'type_identifier', 'member_expression']).map((b) => b.text)
          : [];
        named(name, 'class', decl, { bases: bases.length ? bases : undefined });
        return;
      }
      case 'interface_declaration': {
        const name = decl.childForFieldName('name')?.text;
        if (name) named(name, 'interface', decl);
        return;
      }
      case 'type_alias_declaration': {
        const name = decl.childForFieldName('name')?.text;
        if (name) named(name, 'type', decl);
        return;
      }
      case 'enum_declaration': {
        const name = decl.childForFieldName('name')?.text;
        if (name) named(name, 'enum', decl);
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of decl.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const nameNode = d.childForFieldName('name');
          const value = d.childForFieldName('value');
          if (nameNode?.type !== 'identifier') {
            mergeInto(fileScan, scan(d), file);
            continue;
          }
          const name = nameNode.text;
          const vt = value?.type ?? '';
          let kind: SymbolKind | null = null;
          if (FUNCTION_LIKE.has(vt)) kind = 'function';
          else if (vt === 'class') kind = 'class';
          else if (exported || (vt === 'call_expression' && isPascal(name))) kind = 'variable';
          if (!kind) {
            mergeInto(fileScan, scan(d), file);
            continue;
          }
          const s = scan(d, name);
          if (s.jsx && isPascal(name)) kind = 'component';
          addSymbol({
            name,
            kind,
            exported,
            isDefault,
            lines: [line(d), d.endPosition.row + 1],
            refs: s.refs.list(),
            jsx: s.jsx,
            routes: s.routes.length ? s.routes : undefined,
            requests: s.requests.length ? s.requests : undefined,
          });
        }
        return;
      }
      default:
        mergeInto(fileScan, scan(decl), file);
    }
  };

  for (const n of root.namedChildren) {
    switch (n.type) {
      case 'import_statement': {
        const spec = parseImport(n);
        if (spec) file.imports.push(spec);
        break;
      }
      case 'export_statement': {
        const source = stringValue(n.childForFieldName('source'));
        const decl = n.childForFieldName('declaration');
        const value = n.childForFieldName('value');
        const isDefault = n.children.some((c) => c.type === 'default');
        const clause = n.namedChildren.find((c) => c.type === 'export_clause');
        if (source != null) {
          const spec: ImportSpec = { source, level: 0, names: [], reexport: true, line: line(n) };
          if (clause) {
            for (const s of clause.namedChildren) {
              if (s.type !== 'export_specifier') continue;
              const name = s.childForFieldName('name')?.text;
              const alias = s.childForFieldName('alias')?.text;
              if (name) spec.names.push({ imported: name, local: alias ?? name });
            }
          } else {
            const ns = n.namedChildren.find((c) => c.type === 'namespace_export');
            const id = ns?.namedChildren.find((c) => c.type === 'identifier' || c.type === 'string');
            if (id) spec.names.push({ imported: '*', local: id.text });
            else spec.reexportAll = true;
          }
          file.imports.push(spec);
        } else if (decl) {
          symbolFrom(decl, true, isDefault);
        } else if (value) {
          if (value.type === 'identifier') file.defaultExport = value.text;
          else if (FUNCTION_LIKE.has(value.type) || value.type === 'class') symbolFrom(value, true, true);
          else {
            // `export default defineConfig({...})` and similar: keep it as a symbol.
            const s = scan(value);
            addSymbol({
              name: 'default',
              kind: 'variable',
              exported: true,
              isDefault: true,
              lines: [line(n), n.endPosition.row + 1],
              refs: s.refs.list(),
              jsx: s.jsx,
              routes: s.routes.length ? s.routes : undefined,
              requests: s.requests.length ? s.requests : undefined,
            });
          }
        } else if (clause) {
          for (const s of clause.namedChildren) {
            const name = s.childForFieldName('name')?.text;
            if (name) file.localExports.push(name);
          }
        }
        break;
      }
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration':
      case 'lexical_declaration':
      case 'variable_declaration':
        symbolFrom(n, false, false);
        break;
      case 'comment':
        break;
      default:
        mergeInto(fileScan, scan(n), file);
    }
  }

  file.imports.push(...dynamicImports(root));
  file.fileRefs = fileScan.list();
  file.jsx = file.jsx || file.symbols.some((s) => s.jsx);

  // `export { a }` and `export default a` mark earlier local declarations as exported.
  const exportedNames = new Set(file.localExports);
  if (file.defaultExport) exportedNames.add(file.defaultExport);
  for (const s of file.symbols) {
    if (exportedNames.has(s.name)) s.exported = true;
    if (s.name === file.defaultExport) s.isDefault = true;
  }
}

function mergeInto(into: RefSet, s: Scan, file: ParsedFile) {
  for (const r of s.refs.list()) into.add(r.name, r.kind, r.member);
  file.routes.push(...s.routes);
  file.requests.push(...s.requests);
  if (s.jsx) file.jsx = true;
}
