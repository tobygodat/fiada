// TypeScript / TSX / JavaScript fact extraction.

import type { SymbolKind } from '@fiada/shared';
import type { ClientDecl, HttpRequest, ImportSpec, MountDecl, PageDecl, ParsedFile, ParsedSymbol, RouteDecl, RouterDecl, UrlPart } from '../model.ts';
import { RefSet } from './refs.ts';
import { HTTP_VERBS, line, requestUrl, stringValue, urlParts, type SyntaxNode } from './treesitter.ts';

const FETCH_FNS = new Set(['fetch', '$fetch', 'ofetch', 'ky', 'useSWR', 'useFetch', 'request']);
const ROUTER_OBJECT = /^(app|router|server|fastify|hono|r|routes)$|Router$|router$|App$/;
const FUNCTION_LIKE = new Set(['arrow_function', 'function', 'function_expression', 'generator_function']);
const JSX_TYPES = ['jsx_element', 'jsx_self_closing_element', 'jsx_fragment'];
/** Client verbs, including superagent's `del`. */
const CLIENT_VERB: Record<string, string> = { del: 'DELETE' };
/** `express()`, `new Hono()`, `Fastify()`: the application, with no prefix above it. */
const ROOT_CTOR = /^(express|fastify|Fastify|Hono|Koa|Elysia|polka|createServer|createApp|NestFactory\.create)$/;
/** `express.Router()`, `Router()`, `new Router()` (koa-router): a sub-router mounted somewhere. */
const SUB_CTOR = /^(express\.Router|Router|KoaRouter|new Router)$/;

const isPascal = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s);

interface Scan {
  refs: RefSet;
  jsx: boolean;
  routes: RouteDecl[];
  requests: HttpRequest[];
  routers: RouterDecl[];
  mounts: MountDecl[];
}

/** Collect refs, routes, requests, routers and mounts from everything under `node`. */
function scan(node: SyntaxNode, self?: string): Scan {
  const out: Scan = { refs: new RefSet(self), jsx: false, routes: [], requests: [], routers: [], mounts: [] };
  const { refs } = out;
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
    'variable_declarator',
  ]);
  // descendantsOfType excludes the node itself.
  if (['call_expression', 'object', 'new_expression', 'variable_declarator'].includes(node.type)) nodes.unshift(node);

  for (const n of nodes) {
    const at = line(n);
    switch (n.type) {
      case 'call_expression': {
        const fn = n.childForFieldName('function');
        if (!fn) break;
        if (fn.type === 'identifier') refs.add(fn.text, 'call', at);
        else if (fn.type === 'member_expression') {
          const obj = fn.childForFieldName('object');
          const prop = fn.childForFieldName('property');
          if (obj?.type === 'identifier' && prop) {
            refs.add(obj.text, 'call', at, prop.text);
            memberObjects.add(obj.id);
          }
        }
        httpFromCall(n, fn, out);
        mountFromCall(n, fn, out);
        break;
      }
      case 'new_expression': {
        const ctor = n.childForFieldName('constructor');
        if (ctor?.type === 'identifier') refs.add(ctor.text, 'new', at);
        break;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        out.jsx = true;
        const name = n.childForFieldName('name');
        if (!name) break;
        if (name.type === 'identifier' && isPascal(name.text)) refs.add(name.text, 'jsx', at);
        else if (name.type === 'member_expression' || name.type === 'nested_identifier') {
          const [obj, prop] = name.text.split('.');
          if (obj && prop) refs.add(obj, 'jsx', at, prop);
          const first = name.firstNamedChild;
          if (first?.type === 'identifier') memberObjects.add(first.id);
        }
        break;
      }
      case 'type_identifier':
        refs.add(n.text, 'type', at);
        break;
      case 'nested_type_identifier': {
        const [obj, prop] = n.text.split('.');
        if (obj && prop) refs.add(obj, 'type', at, prop);
        break;
      }
      case 'identifier':
        if (!memberObjects.has(n.id)) refs.add(n.text, 'ref', at);
        break;
      case 'object':
        requestFromObject(n, out.requests);
        break;
      case 'variable_declarator': {
        const r = routerFromDeclarator(n);
        if (r) out.routers.push(r);
        break;
      }
    }
  }
  if (!out.jsx && node.descendantsOfType(JSX_TYPES).length) out.jsx = true;
  return out;
}

/** `const app = express()`, `const router = express.Router()`, `const api = new Hono()`. */
function routerFromDeclarator(d: SyntaxNode): RouterDecl | null {
  const name = d.childForFieldName('name');
  let value = d.childForFieldName('value');
  if (name?.type !== 'identifier' || !value) return null;
  if (value.type === 'await_expression') value = value.namedChildren[0] ?? null;
  if (!value) return null;
  let ctor: string | null = null;
  if (value.type === 'call_expression') ctor = value.childForFieldName('function')?.text ?? null;
  else if (value.type === 'new_expression') ctor = value.childForFieldName('constructor')?.text ?? null;
  if (!ctor) return null;
  if (ROOT_CTOR.test(ctor)) return { name: name.text, root: true, line: line(d) };
  if (SUB_CTOR.test(ctor) || (value.type === 'new_expression' && SUB_CTOR.test(`new ${ctor}`))) return { name: name.text, root: false, line: line(d) };
  return null;
}

/** `app.use("/api", api)`, `app.route("/api", api)` (Hono), `fastify.register(plugin, { prefix: "/api" })`. */
function mountFromCall(call: SyntaxNode, fn: SyntaxNode, out: Scan) {
  if (fn.type !== 'member_expression') return;
  const obj = fn.childForFieldName('object');
  const method = fn.childForFieldName('property')?.text;
  if (obj?.type !== 'identifier') return;
  const argv = call.childForFieldName('arguments')?.namedChildren ?? [];
  const isRouterRef = (n: SyntaxNode | undefined) => n && (n.type === 'identifier' || n.type === 'member_expression' || isRequire(n));
  const childText = (n: SyntaxNode) => (isRequire(n) ? `require:${stringValue(n.childForFieldName('arguments')?.namedChildren[0] ?? null)}` : n.text);
  if (method === 'use' || method === 'route') {
    let prefix = argv.length >= 2 ? urlParts(argv[0], true) : [];
    let child = argv[argv.length - 1];
    // Koa: `app.use(mount("/api", api))` (koa-mount) and `router.use("/", items.routes())` (koa-router).
    const koa = koaChild(child);
    if (koa) {
      if (koa.prefix.length) prefix = [...(prefix ?? []), ...koa.prefix];
      child = koa.child;
    }
    if (!koa && !ROUTER_OBJECT.test(obj.text)) return;
    if (prefix && isRouterRef(child) && !(argv.length === 1 && method === 'route')) {
      out.mounts.push({ parent: obj.text, child: childText(child), prefix, line: line(call) });
    }
  } else if (!ROUTER_OBJECT.test(obj.text)) {
    return;
  } else if (method === 'register' && isRouterRef(argv[0])) {
    let prefix: MountDecl['prefix'] = [];
    for (const pair of argv[1]?.type === 'object' ? argv[1].namedChildren : []) {
      if (pair.type === 'pair' && pair.childForFieldName('key')?.text.replace(/['"]/g, '') === 'prefix') {
        prefix = urlParts(pair.childForFieldName('value'), true) ?? [];
      }
    }
    out.mounts.push({ parent: obj.text, child: childText(argv[0]), prefix, line: line(call) });
  }
}

const isRequire = (n: SyntaxNode) => n.type === 'call_expression' && n.childForFieldName('function')?.text === 'require';

/** `items.routes()` / `items.middleware()` → items; `mount("/api", api)` → api under /api; `mount(routes)` → routes. */
function koaChild(n: SyntaxNode | undefined): { child: SyntaxNode; prefix: MountDecl['prefix'] } | null {
  if (n?.type !== 'call_expression') return null;
  const fn = n.childForFieldName('function');
  const argv = n.childForFieldName('arguments')?.namedChildren ?? [];
  if (fn?.type === 'member_expression' && !argv.length && /^(routes|middleware)$/.test(fn.childForFieldName('property')?.text ?? '')) {
    const obj = fn.childForFieldName('object');
    return obj ? { child: obj, prefix: [] } : null;
  }
  if (fn?.type === 'identifier' && fn.text === 'mount' && argv.length >= 1 && argv.length <= 2) {
    const prefix = argv.length === 2 ? urlParts(argv[0], true) : [];
    const inner = argv[argv.length - 1];
    if (!prefix) return null;
    const nested = koaChild(inner);
    return { child: nested?.child ?? inner, prefix: [...prefix, ...(nested?.prefix ?? [])] };
  }
  return null;
}

function httpFromCall(call: SyntaxNode, fn: SyntaxNode, out: Scan) {
  const args = call.childForFieldName('arguments');
  if (!args) return;
  const argv = args.namedChildren;
  if (!argv.length) return;
  const first = stringValue(argv[0]);

  if (fn.type === 'identifier' && FETCH_FNS.has(fn.text)) {
    const url = requestUrl(argv[0]);
    if (url) out.requests.push({ method: methodFromOptions(argv[1]) ?? 'GET', ...url, line: line(call) });
    return;
  }
  if (fn.type !== 'member_expression') return;
  const obj = fn.childForFieldName('object');
  const verb = fn.childForFieldName('property')?.text ?? '';
  if (!HTTP_VERBS.has(verb) && verb !== 'all' && verb !== 'request' && !CLIENT_VERB[verb]) return;

  const last = argv[argv.length - 1];
  const handlerLike = argv.length >= 2 && (FUNCTION_LIKE.has(last.type) || last.type === 'identifier' || last.type === 'member_expression');
  const routerName = obj?.type === 'identifier' ? obj.text : undefined;
  const routerish = obj != null && ROUTER_OBJECT.test(obj.text.split('.').pop() ?? '');
  // koa-router takes paths without a leading slash: `router.post("documents.list", …)` serves /documents.list.
  // Only on objects named like a router, so `r.get("session", cb)` on a Redis client isn't a route.
  const bare = obj != null && /[rR]outer$/.test(obj.text) && first != null && /^[\w$:{}*-][\w$:.{}*/-]*$/.test(first) ? `/${first}` : null;
  const path = first?.startsWith('/') ? first : bare;
  if (path && handlerLike && (routerish || FUNCTION_LIKE.has(last.type)) && !CLIENT_VERB[verb]) {
    const route: RouteDecl = { method: verb === 'all' ? '*' : verb.toUpperCase(), path, line: line(call) };
    if (routerName) route.router = routerName;
    if (last.type === 'identifier' || last.type === 'member_expression') route.handler = last.text;
    out.routes.push(route);
    return;
  }
  const method = CLIENT_VERB[verb] ?? (HTTP_VERBS.has(verb) ? verb.toUpperCase() : (methodFromOptions(argv[1]) ?? 'GET'));
  // client.get("/items") or client.get({ url: "/items" }) as generated SDKs do.
  const urlNode = argv[0].type === 'object' ? urlOption(argv[0]) : argv[0];
  const url = requestUrl(urlNode);
  if (!url) return;
  const req: HttpRequest = { method, ...url, line: line(call) };
  // An absolute URL replaces the client's base URL (axios, ky, fetch wrappers), so only relative ones go through it.
  if (obj?.type === 'identifier' && !url.base && !/^[`'"]?([a-z][a-z0-9+.-]*:)?\/\//i.test(urlNode?.text ?? '')) req.via = obj.text;
  out.requests.push(req);
}

/** Property names a client keeps its base URL in. */
const BASE_PROP = /^(base_?ur[li]|base_?path|api_?(base|root|url)|prefix_?url)$/i;

/** `"/api"`, `` `${API}/v1` ``, and the fallback in `options.baseUrl || "/api"`. */
function baseValue(n: SyntaxNode | null): UrlPart[] | null {
  if (!n) return null;
  if (n.type === 'binary_expression' && /^(\|\||\?\?)$/.test(n.childForFieldName('operator')?.text ?? '')) {
    return baseValue(n.childForFieldName('right')) ?? baseValue(n.childForFieldName('left'));
  }
  if (n.type === 'parenthesized_expression') return baseValue(n.namedChildren[0] ?? null);
  // Anything else that isn't a plain string, name or concatenation (a call, a conditional) we can't read.
  return /^(string|template_string|identifier|member_expression|binary_expression)$/.test(n.type) ? urlParts(n, true) : null;
}

/** A class that prefixes its requests: `baseUrl = "/api"` as a field, or `this.baseUrl = … "/api"` in a method. */
function classBaseUrl(cls: SyntaxNode): { parts: UrlPart[]; line: number } | undefined {
  const body = cls.childForFieldName('body');
  if (!body) return undefined;
  for (const f of body.namedChildren) {
    if (f.type !== 'public_field_definition' && f.type !== 'field_definition') continue;
    const name = (f.childForFieldName('name') ?? f.childForFieldName('property'))?.text;
    const parts = name && BASE_PROP.test(name) ? baseValue(f.childForFieldName('value')) : null;
    if (parts) return { parts, line: line(f) };
  }
  for (const a of body.descendantsOfType('assignment_expression')) {
    const left = a.childForFieldName('left');
    if (left?.type !== 'member_expression' || left.childForFieldName('object')?.type !== 'this') continue;
    if (!BASE_PROP.test(left.childForFieldName('property')?.text ?? '')) continue;
    const parts = baseValue(a.childForFieldName('right'));
    if (parts) return { parts, line: line(a) };
  }
  return undefined;
}

/**
 * The base URL a constructor or factory call passes in: `{ baseURL: "/api" }` or a leading "/api" string.
 * `null` when the arguments set nothing we can see, `'unknown'` when they may set one we can't read.
 */
function baseArgument(args: SyntaxNode[]): UrlPart[] | null | 'unknown' {
  const first = args[0];
  if (!first) return null;
  if (first.type === 'object') {
    for (const pair of first.namedChildren) {
      if (pair.type === 'spread_element') return 'unknown';
      if (pair.type !== 'pair' && pair.type !== 'shorthand_property_identifier') continue;
      const key = (pair.type === 'pair' ? pair.childForFieldName('key')?.text : pair.text)?.replace(/['"]/g, '') ?? '';
      if (!BASE_PROP.test(key) && !/^prefix$/i.test(key)) continue;
      return (pair.type === 'pair' && baseValue(pair.childForFieldName('value'))) || 'unknown';
    }
    return null;
  }
  const parts = baseValue(first);
  const lead = parts?.[0];
  if (lead && 'lit' in lead && /^(\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(lead.lit)) return parts;
  return 'unknown';
}

/**
 * `new ApiClient()` (its class's base URL applies), `new ApiClient({ baseUrl: "/v2" })`,
 * `axios.create({ baseURL: "/api" })`, `ky.create({ prefixUrl: "/api" })`.
 */
function clientFrom(name: string, value: SyntaxNode, at: number): ClientDecl | null {
  const args = value.childForFieldName('arguments')?.namedChildren ?? [];
  if (value.type === 'new_expression') {
    const ctor = value.childForFieldName('constructor');
    if (ctor?.type !== 'identifier' || !isPascal(ctor.text)) return null;
    const base = baseArgument(args);
    // Arguments that may override the class's base URL, and that we can't read, leave the client unknown.
    if (base === 'unknown') return null;
    return base ? { name, base, line: at } : { name, ctor: ctor.text, line: at };
  }
  if (value.type !== 'call_expression') return null;
  const fn = value.childForFieldName('function');
  if (fn?.type !== 'member_expression' || !/^(create|extend)$/.test(fn.childForFieldName('property')?.text ?? '')) return null;
  const base = baseArgument(args);
  return base && base !== 'unknown' ? { name, base, line: at } : null;
}

/** The `url` or `path` value in `client.get({ url: "/items" })`, as generated SDKs call it. */
function urlOption(opts: SyntaxNode): SyntaxNode | null {
  for (const pair of opts.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
    if (key === 'url' || key === 'path') return pair.childForFieldName('value');
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
  let url: { path: string; base?: string } | null = null;
  for (const pair of obj.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
    if (key === 'method') method = stringValue(pair.childForFieldName('value'));
    else if (key === 'url') url = requestUrl(pair.childForFieldName('value'));
  }
  if (method && url) requests.push({ method: method.toUpperCase(), ...url, line: line(obj) });
}

// ── client-side pages ──────────────────────────────────────────────────

const pairValue = (obj: SyntaxNode, key: string) =>
  obj.namedChildren.find((p) => p.type === 'pair' && p.childForFieldName('key')?.text.replace(/['"]/g, '') === key)?.childForFieldName('value') ??
  obj.namedChildren.find((p) => p.type === 'shorthand_property_identifier' && p.text === key) ??
  null;

/** The component a route renders: `element={<Items />}`, `component={Items}`, `Component: Items`. */
function componentOf(n: SyntaxNode | null): string | undefined {
  if (!n) return undefined;
  if (n.type === 'jsx_expression') return componentOf(n.namedChildren[0] ?? null);
  if (n.type === 'identifier' || n.type === 'shorthand_property_identifier') return isPascal(n.text) ? n.text : undefined;
  if (n.type === 'jsx_self_closing_element') return n.childForFieldName('name')?.text;
  if (n.type === 'jsx_element') return n.childForFieldName('open_tag')?.childForFieldName('name')?.text;
  if (n.type === 'parenthesized_expression') return componentOf(n.namedChildren[0] ?? null);
  return undefined;
}

const joinPage = (parent: string, p: string) => (p.startsWith('/') ? p : `${parent.replace(/\/$/, '')}/${p}`);

/** "/_layout/items/$id" → "/items/{id}": drop pathless layout and group segments, name params. */
export function pagePath(p: string): string {
  const segs = p
    .split('/')
    .filter((s) => s && s !== 'index' && !s.startsWith('_') && !/^\(.*\)$/.test(s))
    .map((s) => (s === '$' || s === '*' ? '{*}' : s.replace(/^\$(.+)$/, '{$1}').replace(/^:(.+?)\??$/, '{$1}')));
  return '/' + segs.join('/');
}

function extractPages(root: SyntaxNode, file: ParsedFile) {
  const pages: PageDecl[] = [];
  // React Router JSX: <Route path="items" element={<Items />}>…nested <Route>s…</Route>
  const jsxPath = (el: SyntaxNode): string | null => {
    const open = el.type === 'jsx_element' ? el.childForFieldName('open_tag') : el;
    if (!open || open.childForFieldName('name')?.text !== 'Route') return null;
    let path: string | null = null;
    let component: string | undefined;
    for (const a of open.namedChildren) {
      if (a.type !== 'jsx_attribute') continue;
      const [k, v] = [a.namedChildren[0]?.text, a.namedChildren[1] ?? null];
      if (k === 'path') path = v?.type === 'string' ? stringValue(v) : v?.type === 'jsx_expression' ? stringValue(v.namedChildren[0] ?? null) : null;
      else if (k === 'element' || k === 'component' || k === 'Component') component = componentOf(v);
    }
    if (path == null) return null;
    let full = path;
    for (let p = el.parent; p; p = p.parent) {
      if (p.type !== 'jsx_element') continue;
      const parentPath = jsxPathOnly(p);
      if (parentPath != null) {
        full = joinPage(parentPath, full);
        if (parentPath.startsWith('/')) break;
      }
    }
    // A <Route> with no element only groups its children under a path.
    if (component) pages.push({ path: pagePath(full), component, line: line(el) });
    return full;
  };
  const jsxPathOnly = (el: SyntaxNode): string | null => {
    const open = el.childForFieldName('open_tag');
    if (open?.childForFieldName('name')?.text !== 'Route') return null;
    const attr = open.namedChildren.find((a) => a.type === 'jsx_attribute' && a.namedChildren[0]?.text === 'path');
    const v = attr?.namedChildren[1] ?? null;
    return v?.type === 'string' ? stringValue(v) : v?.type === 'jsx_expression' ? stringValue(v.namedChildren[0] ?? null) : null;
  };
  for (const el of root.descendantsOfType(['jsx_element', 'jsx_self_closing_element'])) jsxPath(el);

  // Route objects: createBrowserRouter([{ path: "items", element: <Items />, children: [...] }]), createRoute({ path, component }).
  for (const obj of root.descendantsOfType('object')) {
    const pathNode = pairValue(obj, 'path');
    const path = stringValue(pathNode);
    if (path == null || !(path.startsWith('/') || /^[\w$:.-]/.test(path))) continue;
    const component = componentOf(pairValue(obj, 'element')) ?? componentOf(pairValue(obj, 'component')) ?? componentOf(pairValue(obj, 'Component'));
    if (!component) continue;
    let full = path;
    for (let p = obj.parent; p; p = p.parent) {
      if (p.type !== 'object') continue;
      const parentPath = stringValue(pairValue(p, 'path'));
      if (parentPath != null) {
        full = joinPage(parentPath, full);
        if (parentPath.startsWith('/')) break;
      }
    }
    pages.push({ path: pagePath(full), component, line: line(obj) });
  }

  // TanStack Router file routes: createFileRoute("/_layout/items")({ component: Items })
  for (const call of root.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'call_expression' || fn.childForFieldName('function')?.text !== 'createFileRoute') continue;
    const path = stringValue(fn.childForFieldName('arguments')?.namedChildren[0] ?? null);
    if (path == null) continue;
    const opts = call.childForFieldName('arguments')?.namedChildren[0];
    const component = opts?.type === 'object' ? componentOf(pairValue(opts, 'component')) : undefined;
    pages.push({ path: pagePath(path), component, line: line(call) });
  }
  file.pages.push(...pages);
}

// ── imports ────────────────────────────────────────────────────────────

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

/** Parameter names of a function-like node, in order ("" for destructured ones). */
function paramsOf(fn: SyntaxNode): string[] | undefined {
  const params = fn.childForFieldName('parameters') ?? (fn.childForFieldName('parameter') ? { namedChildren: [fn.childForFieldName('parameter')!] } : null);
  if (!params) return undefined;
  const names = params.namedChildren.map((p) => {
    if (p.type === 'identifier') return p.text;
    const pat = p.childForFieldName('pattern') ?? (p.type === 'assignment_pattern' ? p.childForFieldName('left') : null);
    return pat?.type === 'identifier' ? pat.text : '';
  });
  return names.length ? names : undefined;
}

/** Types of a parameter that is itself an application (`app: Koa`) or a router (`router: Router`). */
const APP_TYPE = /^(Koa|Express|Application|FastifyInstance|Hono)\b/;
const ROUTER_TYPE = /^(Router|KoaRouter|IRouter)\b/;

/** `function init(app: Koa = new Koa())`: a parameter that holds an app or router, named by position like bindParams does. */
function paramRouters(fn: SyntaxNode): RouterDecl[] {
  const out: RouterDecl[] = [];
  const params = fn.childForFieldName('parameters')?.namedChildren ?? [];
  params.forEach((p, i) => {
    const type = p.childForFieldName('type')?.text.replace(/^:\s*/, '') ?? '';
    const value = p.childForFieldName('value') ?? (p.type === 'assignment_pattern' ? p.childForFieldName('right') : null);
    const ctor = value?.type === 'new_expression' ? value.childForFieldName('constructor')?.text : value?.type === 'call_expression' ? value.childForFieldName('function')?.text : undefined;
    if ((ctor && ROOT_CTOR.test(ctor)) || APP_TYPE.test(type)) out.push({ name: `#${i}`, root: true, line: line(p) });
    else if ((ctor && SUB_CTOR.test(ctor)) || ROUTER_TYPE.test(type)) out.push({ name: `#${i}`, root: false, line: line(p) });
  });
  return out;
}

/** Routes and mounts on a router passed in as a parameter refer to it by position. */
function bindParams(s: Scan, params: string[] | undefined) {
  if (!params) return;
  const idx = (name: string | undefined) => (name ? params.indexOf(name) : -1);
  for (const r of s.routes) if (idx(r.router) >= 0) r.router = `#${idx(r.router)}`;
  for (const m of s.mounts) if (idx(m.parent) >= 0) m.parent = `#${idx(m.parent)}`;
}

export function extractTs(root: SyntaxNode, file: ParsedFile) {
  const fileScan = new RefSet();
  const addSymbol = (s: ParsedSymbol) => file.symbols.push(s);
  const extras = (s: Scan) => ({
    routes: s.routes.length ? s.routes : undefined,
    requests: s.requests.length ? s.requests : undefined,
    routers: s.routers.length ? s.routers : undefined,
    mounts: s.mounts.length ? s.mounts : undefined,
  });

  const symbolFrom = (decl: SyntaxNode, exported: boolean, isDefault: boolean) => {
    const lines: [number, number] = [line(decl), decl.endPosition.row + 1];
    const named = (name: string, kind: SymbolKind, body: SyntaxNode, extra: Partial<ParsedSymbol> = {}) => {
      const s = scan(body, name);
      const isFn = FUNCTION_LIKE.has(body.type) || body.type === 'function_declaration';
      const params = isFn ? paramsOf(body) : undefined;
      bindParams(s, params);
      if (isFn) s.routers.push(...paramRouters(body));
      if (kind === 'function' && s.jsx && isPascal(name)) kind = 'component';
      addSymbol({ name, kind, exported, isDefault, lines, refs: s.refs.list(), jsx: s.jsx, params, ...extras(s), ...extra });
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
        const clientBase = classBaseUrl(decl);
        named(name, 'class', decl, { bases: bases.length ? bases : undefined, clientBase });
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
          // Module-level string constants, for resolving URL bases and mount prefixes.
          const str = value && (vt === 'string' || vt === 'template_string') ? stringValue(value) : null;
          if (str != null && !str.includes('{}')) file.constants.push({ name, value: str, line: line(d) });
          const client = value && clientFrom(name, value, line(d));
          if (client) (file.clients ??= []).push(client);
          let kind: SymbolKind | null = null;
          if (FUNCTION_LIKE.has(vt)) kind = 'function';
          else if (vt === 'class') kind = 'class';
          else if (exported || (vt === 'call_expression' && isPascal(name))) kind = 'variable';
          if (!kind) {
            mergeInto(fileScan, scan(d), file);
            continue;
          }
          const s = scan(d, name);
          const params = value && FUNCTION_LIKE.has(vt) ? paramsOf(value) : undefined;
          bindParams(s, params);
          if (value && FUNCTION_LIKE.has(vt)) s.routers.push(...paramRouters(value));
          if (s.jsx && isPascal(name)) kind = 'component';
          addSymbol({
            name,
            kind,
            exported,
            isDefault,
            lines: [line(d), d.endPosition.row + 1],
            refs: s.refs.list(),
            jsx: s.jsx,
            params,
            ...extras(s),
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
              ...extras(s),
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
      case 'expression_statement': {
        // CommonJS: `module.exports = router` makes router the default export.
        const a = n.namedChildren[0];
        if (a?.type === 'assignment_expression' && a.childForFieldName('left')?.text === 'module.exports') {
          const right = a.childForFieldName('right');
          if (right?.type === 'identifier') file.defaultExport ??= right.text;
        }
        mergeInto(fileScan, scan(n), file);
        break;
      }
      default:
        mergeInto(fileScan, scan(n), file);
    }
  }

  file.imports.push(...dynamicImports(root));
  file.fileRefs = fileScan.list();
  file.jsx = file.jsx || file.symbols.some((s) => s.jsx);
  if (file.jsx || /createFileRoute|createBrowserRouter|createRoute|<Route/.test(root.text.slice(0, 200_000))) extractPages(root, file);

  // `export { a }` and `export default a` mark earlier local declarations as exported.
  const exportedNames = new Set(file.localExports);
  if (file.defaultExport) exportedNames.add(file.defaultExport);
  for (const s of file.symbols) {
    if (exportedNames.has(s.name)) s.exported = true;
    if (s.name === file.defaultExport) s.isDefault = true;
  }
}

function mergeInto(into: RefSet, s: Scan, file: ParsedFile) {
  into.merge(s.refs.list());
  file.routes.push(...s.routes);
  file.requests.push(...s.requests);
  file.routers.push(...s.routers);
  file.mounts.push(...s.mounts);
  if (s.jsx) file.jsx = true;
}

