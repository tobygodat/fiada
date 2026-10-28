// Go fact extraction: imports, top-level funcs, methods, types, constants,
// and the routers of gin, echo, chi, fiber, gorilla/mux and net/http.

import type { SymbolKind } from '@fiada/shared';
import type { HttpRequest, ImportSpec, MountDecl, OrmRef, ParsedFile, ParsedSymbol, RouteDecl, RouterDecl } from '../model.ts';
import { RefSet } from './refs.ts';
import { fieldChildren, line, requestUrl, stringValue, urlParts, type SyntaxNode } from './treesitter.ts';

const ROUTE_METHOD: Record<string, string> = {
  GET: 'GET', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', DELETE: 'DELETE', HEAD: 'HEAD', OPTIONS: 'OPTIONS', Any: '*',
  Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', All: '*',
  Handle: '*', HandleFunc: '*', Match: '*', Add: '*', Method: '*', MethodFunc: '*',
};

/** Constructors of an application router, whose routes have no prefix above them. */
const ROOT_CTOR = /^(gin\.(Default|New)|echo\.New|chi\.NewRouter|chi\.NewMux|http\.NewServeMux|fiber\.New|mux\.NewRouter|httprouter\.New)$/;

/** Parameter types that carry a router into a registration function. */
const ROUTER_TYPE = /(gin\.(Engine|RouterGroup|IRouter|IRoutes)|echo\.(Echo|Group)|chi\.(Router|Mux)|http\.ServeMux|fiber\.(App|Router)|mux\.Router|httprouter\.Router)\b/;
const HTTP_CLIENT: Record<string, string> = { Get: 'GET', Post: 'POST', Head: 'HEAD', PostForm: 'POST' };

/** Registrations that may take the HTTP method before the path. chi's Handle/HandleFunc and net/http's don't; gin's and httprouter's Handle do. */
const VERB_FIRST = new Set(['Handle', 'Handler', 'HandlerFunc', 'Method', 'MethodFunc', 'Add', 'Match']);
const isMethod = (s: string) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/i.test(s);

/** `"GET"`, `http.MethodGet`, `[]string{"GET", http.MethodPost}` → the methods; null for anything else. */
function methodsOf(n: SyntaxNode): string[] | null {
  const lit = stringValue(n);

  if (lit != null) return isMethod(lit) ? [lit.toUpperCase()] : null;
  const named = n.type === 'selector_expression' && n.text.match(/^http\.Method(\w+)$/);

  if (named) return [named[1].toUpperCase()];

  if (n.type === 'composite_literal') {
    const items = (n.childForFieldName('body')?.namedChildren ?? []).map((c) => methodsOf(c.type === 'literal_element' ? (c.namedChildren[0] ?? c) : c));

    return items.length && items.every(Boolean) ? items.flat() as string[] : null;
  }

  return null;
}

const exportedName = (s: string) => /^[A-Z]/.test(s);

/** "github.com/go-chi/chi/v5" → "chi", "gopkg.in/yaml.v3" → "yaml". The real package name wins in the linker when the package is indexed. */
export function goPackageName(path: string): string {
  const segs = path.split('/');
  let last = segs.pop() ?? path;

  if (/^v\d+$/.test(last) && segs.length) last = segs.pop()!;

  return last.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/[-.]go$/, '').replace(/[^A-Za-z0-9_]/g, '_');
}

function parseImports(decl: SyntaxNode): ImportSpec[] {
  const out: ImportSpec[] = [];

  for (const spec of decl.descendantsOfType('import_spec')) {
    const source = stringValue(spec.childForFieldName('path'));

    if (!source) continue;
    const alias = spec.childForFieldName('name')?.text;

    if (alias === '_') {
      out.push({ source, level: 0, names: [], line: line(spec) });
      continue;
    }

    // A dot import puts the package's names in scope; treat it like `export *`.
    if (alias === '.') {
      out.push({ source, level: 0, names: [], reexportAll: true, line: line(spec) });
      continue;
    }

    out.push({ source, level: 0, names: [{ imported: '*', local: alias ?? goPackageName(source) }], line: line(spec) });
  }

  return out;
}

interface Scan {
  refs: RefSet;
  routes: RouteDecl[];
  requests: HttpRequest[];
  routers: RouterDecl[];
  mounts: MountDecl[];
}

/** Identifiers in slots that name a field or key rather than refer to anything. */
function isNameSlot(n: SyntaxNode): boolean {
  const p = n.parent;

  if (!p) return false;

  if (p.type === 'literal_element' && p.parent?.type === 'keyed_element' && p.parent.namedChildren[0]?.id === p.id) return true;

  if (p.type === 'keyed_element' && p.namedChildren[0]?.id === n.id) return true;

  return false;
}

/** The closure a `r.Route("/x", func(r chi.Router) {…})` call opens, as a router name, if `name` is its parameter. */
function closureRouter(call: SyntaxNode, name: string): string | null {
  for (let p = call.parent; p; p = p.parent) {
    if (p.type !== 'func_literal') continue;
    const param = p.childForFieldName('parameters')?.namedChildren[0]?.childForFieldName('name')?.text;
    const outer = p.parent?.parent;

    if (param === name && outer?.type === 'call_expression' && /\.(Route|Group)$/.test(outer.childForFieldName('function')?.text ?? '')) {
      return `@${line(outer)}`;
    }

    if (param === name) return null;
  }

  return null;
}

function scan(node: SyntaxNode, params: string[], routerParams: Set<string>, self?: string): Scan {
  const out: Scan = { refs: new RefSet(self), routes: [], requests: [], routers: [], mounts: [] };
  const { refs } = out;
  const seen = new Set<number>();
  /** Router variables declared or received in this scope, for recognising `Register(r)` mounts. */
  const routerVars = new Set(routerParams);

  const routerName = (call: SyntaxNode, name: string) => {
    const closure = closureRouter(call, name);

    if (closure) return closure;
    const i = params.indexOf(name);

    return i >= 0 ? `#${i}` : name;
  };

  const nodes = node.descendantsOfType([
    'call_expression',
    'selector_expression',
    'qualified_type',
    'type_identifier',
    'identifier',
    'composite_literal',
    'short_var_declaration',
    'assignment_statement',
    'var_spec',
  ]);

  for (const n of nodes) {
    const at = line(n);

    switch (n.type) {
      case 'call_expression': {
        const fn = n.childForFieldName('function');

        if (!fn) break;

        if (fn.type === 'identifier') {
          refs.add(fn.text, 'call', at);
          seen.add(fn.id);
        } else if (fn.type === 'selector_expression') {
          const operand = fn.childForFieldName('operand');
          const field = fn.childForFieldName('field')?.text;

          if (operand?.type === 'identifier' && field) {
            refs.add(operand.text, 'call', at, field);
            seen.add(operand.id);
            seen.add(fn.id);
          }

          if (operand && field) httpFromCall(n, operand, field, out, routerName);
        }

        // `Register(v1.Group("/x"))` or `Register(r)`: the callee's parameter is a router mounted here.
        const args = n.childForFieldName('arguments')?.namedChildren ?? [];
        args.forEach((a, i) => {
          const g = groupCall(a);

          if (g) out.mounts.push({ parent: routerName(n, g.parent), child: { fn: fn.text, arg: i }, prefix: g.prefix, line: at });
          else if (a.type === 'identifier' && routerVars.has(a.text)) {
            out.mounts.push({ parent: routerName(n, a.text), child: { fn: fn.text, arg: i }, prefix: [], line: at });
          }
        });
        break;
      }

      case 'selector_expression': {
        if (seen.has(n.id)) break;
        const operand = n.childForFieldName('operand');
        const field = n.childForFieldName('field')?.text;

        if (operand?.type === 'identifier' && field && !seen.has(operand.id)) {
          refs.add(operand.text, 'ref', at, field);
          seen.add(operand.id);
        }

        break;
      }

      case 'qualified_type': {
        const pkg = n.childForFieldName('package')?.text;
        const name = n.childForFieldName('name');

        if (pkg && name) {
          refs.add(pkg, 'type', at, name.text);
          seen.add(name.id);
        }

        break;
      }

      case 'type_identifier':
        if (!seen.has(n.id)) refs.add(n.text, 'type', at);
        break;
      case 'composite_literal': {
        const type = n.childForFieldName('type');

        if (type?.type === 'type_identifier') {
          refs.add(type.text, 'new', at);
          seen.add(type.id);
        } else if (type?.type === 'qualified_type') {
          const pkg = type.childForFieldName('package')?.text;
          const name = type.childForFieldName('name');

          if (pkg && name) {
            refs.add(pkg, 'new', at, name.text);
            seen.add(name.id);
          }
        }

        break;
      }

      case 'identifier':
        if (!seen.has(n.id) && !isNameSlot(n)) refs.add(n.text, 'ref', at);
        break;
      case 'short_var_declaration':
      case 'assignment_statement':
      case 'var_spec': {
        const left = n.childForFieldName('left') ?? null;
        const names = n.type === 'var_spec' ? fieldChildren(n, 'name') : (left?.namedChildren ?? []);
        const right = n.type === 'var_spec' ? n.childForFieldName('value') : n.childForFieldName('right');
        const value = right?.namedChildren[0];
        const name = names[0]?.type === 'identifier' ? names[0].text : null;

        if (!name || !value || value.type !== 'call_expression') break;
        const ctor = value.childForFieldName('function')?.text ?? '';

        if (ROOT_CTOR.test(ctor)) {
          out.routers.push({ name, root: true, line: at });
          routerVars.add(name);
        } else {
          const g = groupCall(value);

          if (g) {
            out.routers.push({ name, root: false, line: at });
            out.mounts.push({ parent: routerName(n, g.parent), child: name, prefix: g.prefix, line: at });
            routerVars.add(name);
          }
        }

        break;
      }
    }
  }

  return out;
}

/** `r.Group("/api")`, `e.Group("/api")`, `r.PathPrefix("/api").Subrouter()`, `r.Route("/api", …)`. */
function groupCall(n: SyntaxNode): { parent: string; prefix: MountDecl['prefix'] } | null {
  if (n.type !== 'call_expression') return null;
  const fn = n.childForFieldName('function');

  if (fn?.type !== 'selector_expression') return null;
  const field = fn.childForFieldName('field')?.text;
  let operand = fn.childForFieldName('operand');

  if (field === 'Subrouter' && operand?.type === 'call_expression') return groupCall(operand);

  if (field !== 'Group' && field !== 'PathPrefix' && field !== 'Route' && field !== 'Mount') return null;
  const arg = n.childForFieldName('arguments')?.namedChildren[0] ?? null;
  const prefix = urlParts(arg, true);

  if (operand?.type === 'identifier' && prefix) return { parent: operand.text, prefix };

  return null;
}

function httpFromCall(call: SyntaxNode, operand: SyntaxNode, field: string, out: Scan, routerName: (call: SyntaxNode, name: string) => string) {
  const argv = call.childForFieldName('arguments')?.namedChildren ?? [];

  // net/http client: http.Get(url), http.NewRequest("GET", url, body), http.NewRequestWithContext(ctx, "GET", url, body)
  if (operand.text === 'http' && HTTP_CLIENT[field]) {
    const url = requestUrl(argv[0] ?? null);

    if (url) out.requests.push({ method: HTTP_CLIENT[field], ...url, line: line(call) });

    return;
  }

  if (operand.text === 'http' && (field === 'NewRequest' || field === 'NewRequestWithContext')) {
    const off = field === 'NewRequest' ? 0 : 1;
    const method = stringValue(argv[off] ?? null)?.toUpperCase() ?? (argv[off]?.text.match(/^http\.Method(\w+)$/)?.[1].toUpperCase() ?? null);
    const url = requestUrl(argv[off + 1] ?? null);

    if (method && url) out.requests.push({ method, ...url, line: line(call) });

    return;
  }

  if (!(field in ROUTE_METHOD) || argv.length < 2) return;
  const last = argv[argv.length - 1];

  // A handler is never a string: `q.Add("next", "/home")` and `c.Get("key", "/x")` aren't routes.
  if (stringValue(last) != null) return;
  let methods = [ROUTE_METHOD[field]];
  let pathArg = argv[0];
  // Method first: gin/httprouter r.Handle("GET", "/x", h), chi r.Method(http.MethodGet, "/x", h),
  // echo/fiber e.Add("GET", "/x", h), echo e.Match([]string{"GET", "POST"}, "/x", h).
  const first = stringValue(argv[0]);

  if (VERB_FIRST.has(field) && argv.length >= 3 && (first != null ? isMethod(first) : stringValue(argv[1]) != null)) {
    methods = methodsOf(argv[0]) ?? ['*'];
    pathArg = argv[1];
  }

  let path = stringValue(pathArg);

  if (path == null) return;
  // Go 1.22 patterns: "GET /items/{id}"
  const pattern = path.match(/^([A-Z]+)\s+(\/.*)$/);

  if (pattern) [methods, path] = [[pattern[1]], pattern[2]];

  if (!path.startsWith('/') && path !== '') return;
  // gorilla/mux: r.HandleFunc("/x", h).Methods("GET", "POST")
  const chained = call.parent?.type === 'selector_expression' && call.parent.childForFieldName('field')?.text === 'Methods' ? call.parent.parent : null;
  const listed = chained?.childForFieldName('arguments')?.namedChildren.flatMap((a) => methodsOf(a) ?? []);

  if (listed?.length) methods = listed;

  for (const method of new Set(methods)) {
    const route: RouteDecl = { method, path, line: line(call) };

    if (operand.type === 'identifier') route.router = operand.text === 'http' ? 'http' : routerName(call, operand.text);

    if (last.type === 'identifier' || last.type === 'selector_expression') route.handler = last.text;
    out.routes.push(route);
  }
}

/** Struct fields: embedded types become bases, gorm tags mark mapped columns and relationships. */
function structInfo(struct: SyntaxNode): { bases: string[]; columns: boolean; orm: OrmRef[] } {
  const bases: string[] = [];
  const orm: OrmRef[] = [];
  let columns = false;

  for (const f of struct.descendantsOfType('field_declaration')) {
    if (f.parent?.parent?.id !== struct.id) continue;
    const type = f.childForFieldName('type');
    const tag = f.childForFieldName('tag')?.text ?? '';

    if (!f.childForFieldName('name') && type) bases.push(type.text.replace(/^\*/, ''));

    if (/gorm:"/.test(tag)) columns = true;
    const target = type?.text.replace(/^[[\]*]+/, '').split('.').pop();

    if (target && /gorm:"[^"]*(foreignKey|ForeignKey|many2many|references)/.test(tag)) orm.push({ kind: 'relationship', target, line: line(f) });
  }

  if (bases.some((b) => /(^|\.)Model$/.test(b))) columns = true;

  return { bases, columns, orm };
}

const paramList = (fn: SyntaxNode): { names: string[]; routers: Set<string> } => {
  const names: string[] = [];
  const routers = new Set<string>();

  for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    const type = p.childForFieldName('type')?.text ?? '';
    const ids = fieldChildren(p, 'name');

    if (!ids.length) names.push('');

    for (const id of ids) {
      names.push(id.text);

      if (ROUTER_TYPE.test(type)) routers.add(id.text);
    }
  }

  return { names, routers };
};

export function extractGo(root: SyntaxNode, file: ParsedFile) {
  const fileRefs = new RefSet();

  const push = (name: string, kind: SymbolKind, node: SyntaxNode, s: Scan, extra: Partial<ParsedSymbol> = {}) => {
    file.symbols.push({
      name,
      kind,
      exported: exportedName(name.split('.').pop()!),
      lines: [line(node), node.endPosition.row + 1],
      refs: s.refs.list(),
      routes: s.routes.length ? s.routes : undefined,
      requests: s.requests.length ? s.requests : undefined,
      routers: s.routers.length ? s.routers : undefined,
      mounts: s.mounts.length ? s.mounts : undefined,
      ...extra,
    });
  };

  for (const n of root.namedChildren) {
    switch (n.type) {
      case 'package_clause':
        file.goPackage = n.namedChildren[0]?.text;
        break;
      case 'import_declaration':
        file.imports.push(...parseImports(n));
        break;
      case 'function_declaration': {
        const name = n.childForFieldName('name')?.text;

        if (!name) break;
        const { names, routers } = paramList(n);
        push(name, 'function', n, scan(n, names, routers, name), { params: names.length ? names : undefined });
        break;
      }

      case 'method_declaration': {
        const name = n.childForFieldName('name')?.text;
        const recvType = n.childForFieldName('receiver')?.descendantsOfType('type_identifier')[0]?.text;

        if (!name) break;
        const { names, routers } = paramList(n);
        const s = scan(n, names, routers, recvType);
        // `func (m ArticleModel) TableName() string { return "articles" }` names a GORM table.
        let extra: Partial<ParsedSymbol> = { receiver: recvType, params: names.length ? names : undefined };

        if (name === 'TableName') {
          const ret = n.childForFieldName('body')?.descendantsOfType('return_statement')[0];
          const lit = ret?.descendantsOfType(['interpreted_string_literal', 'raw_string_literal'])[0];
          const t = lit && stringValue(lit);

          // The struct may be declared later or in another file of the package; linkGoTableNames moves it there.
          if (t && recvType) extra = { ...extra, tableName: t };
        }

        push(recvType ? `${recvType}.${name}` : name, 'function', n, s, extra);
        break;
      }

      case 'type_declaration': {
        for (const spec of n.namedChildren) {
          if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue;
          const name = spec.childForFieldName('name')?.text;
          const type = spec.childForFieldName('type');

          if (!name || !type) continue;
          const s = scan(spec, [], new Set(), name);

          if (type.type === 'struct_type') {
            const info = structInfo(type);
            push(name, 'class', spec, s, {
              bases: info.bases.length ? info.bases : undefined,
              columns: info.columns || undefined,
              orm: info.orm.length ? info.orm : undefined,
            });
          } else push(name, type.type === 'interface_type' ? 'interface' : 'type', spec, s);
        }

        break;
      }

      case 'const_declaration':
      case 'var_declaration': {
        for (const spec of n.descendantsOfType(['const_spec', 'var_spec'])) {
          const names = fieldChildren(spec, 'name');
          const values = spec.childForFieldName('value')?.namedChildren ?? [];
          names.forEach((id, i) => {
            const v = values[i];
            const str = v && (v.type === 'interpreted_string_literal' || v.type === 'raw_string_literal') ? stringValue(v) : null;

            if (str != null) file.constants.push({ name: id.text, value: str, line: line(spec) });
          });
          const s = scan(spec, [], new Set());

          if (names.some((id) => exportedName(id.text)) && names.length === 1) push(names[0].text, 'variable', spec, s);
          else {
            fileRefs.merge(s.refs.list());
            file.routers.push(...s.routers);
            file.mounts.push(...s.mounts);
          }
        }

        break;
      }

      case 'comment':
        break;
      default: {
        const s = scan(n, [], new Set());
        fileRefs.merge(s.refs.list());
        file.routes.push(...s.routes);
        file.requests.push(...s.requests);
      }
    }
  }

  file.fileRefs = fileRefs.list();
}

/**
 * Give each GORM struct the table its `TableName()` method returns. Methods
 * can sit anywhere in the package (before the struct, or in another file), so
 * this runs once every file of a repository is parsed. A package is a folder.
 */
export function linkGoTableNames(files: ParsedFile[]) {
  const dirOf = (f: ParsedFile) => f.path.slice(0, Math.max(0, f.path.lastIndexOf('/')));
  const structs = new Map<string, ParsedSymbol>(); // "<dir>::<name>"

  for (const f of files) {
    if (f.lang !== 'go') continue;

    for (const s of f.symbols) if (s.kind === 'class') structs.set(`${dirOf(f)}::${s.name}`, s);
  }

  for (const f of files) {
    if (f.lang !== 'go') continue;

    for (const s of f.symbols) {
      if (!s.tableName || !s.receiver || s.name !== `${s.receiver}.TableName`) continue;
      const owner = structs.get(`${dirOf(f)}::${s.receiver}`);

      if (!owner) continue;
      owner.tableName = s.tableName;
      delete s.tableName;
    }
  }
}
