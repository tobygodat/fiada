// Python fact extraction.

import type { SymbolKind } from '@fiada/shared';
import type { ConstDecl, HttpRequest, ImportSpec, MountDecl, OrmRef, ParsedFile, RouteDecl, RouterDecl } from '../model.ts';
import { RefSet } from './refs.ts';
import { HTTP_VERBS, line, requestUrl, stringValue, urlParts, type SyntaxNode } from './treesitter.ts';

const ROUTE_ATTRS = new Set([...HTTP_VERBS, 'route', 'api_route', 'websocket']);
const ENUM_BASES = /(^|\.)(Enum|IntEnum|StrEnum|Flag|IntFlag)$/;
const INTERFACE_BASES = /(^|\.)(Protocol|TypedDict|ABC)$/;

/** Application objects: routes on them have no prefix above them. */
const ROOT_CTOR = /(^|\.)(FastAPI|Flask|Starlette|Quart|Sanic|Litestar|APIFlask)$/;

/** Routers that get mounted somewhere else. */
const SUB_CTOR = /(^|\.)(APIRouter|Blueprint|Router|APIBlueprint)$/;

/** Class-level calls that declare mapped columns (SQLAlchemy, Flask-SQLAlchemy). SQLModel tables say `table=True` instead. */
const COLUMN_CALL = /(^|\.)(Column|mapped_column|column_property|relationship)$/;

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
  routers: RouterDecl[];
  mounts: MountDecl[];
}

const keyword = (args: SyntaxNode[], name: string) =>
  args.find((a) => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === name)?.childForFieldName('value') ?? null;

const positional = (args: SyntaxNode[]) => args.filter((a) => a.type !== 'keyword_argument' && a.type !== 'comment');

function scan(node: SyntaxNode, self?: string): Scan {
  const out: Scan = { refs: new RefSet(self), requests: [], routers: [], mounts: [] };
  const { refs } = out;
  const memberObjects = new Set<number>();
  const typeIds = new Set<number>();

  for (const t of node.descendantsOfType('type')) {
    for (const id of t.descendantsOfType('identifier')) typeIds.add(id.id);

    // Forward references: `Mapped[list["Post"]]`.
    for (const str of t.descendantsOfType('string')) {
      const v = stringValue(str);

      if (!v || !/^[A-Za-z_][\w.]*$/.test(v)) continue;
      const [name, member] = v.split('.');
      refs.add(name, 'type', line(str), member);
    }
  }

  const all = node.descendantsOfType(['call', 'identifier', 'assignment']);

  if (node.type === 'assignment') all.unshift(node);

  for (const n of all) {
    const at = line(n);

    if (n.type === 'assignment') {
      const r = routerFromAssignment(n);

      if (r) out.routers.push(r);
    } else if (n.type === 'call') {
      const fn = n.childForFieldName('function');

      if (fn?.type === 'identifier') refs.add(fn.text, 'call', at);
      else if (fn?.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        const attr = fn.childForFieldName('attribute')?.text;

        if (obj?.type === 'identifier' && attr) {
          refs.add(obj.text, 'call', at, attr);
          memberObjects.add(obj.id);

          // `@router.get("/x")` is a route, not a request.
          if (HTTP_VERBS.has(attr) && n.parent?.type !== 'decorator') {
            const url = requestUrl(n.childForFieldName('arguments')?.namedChildren[0] ?? null);

            if (url) out.requests.push({ method: attr.toUpperCase(), ...url, line: at });
          }

          const m = mountFromCall(obj.text, attr, n);

          if (m) out.mounts.push(m);
        }
      }
    } else if (!memberObjects.has(n.id) && !isNameSlot(n)) {
      refs.add(n.text, typeIds.has(n.id) ? 'type' : 'ref', at);
    }
  }

  return out;
}

/** `app = FastAPI()`, `router = APIRouter(prefix="/items")`, `bp = Blueprint("x", __name__)`. */
function routerFromAssignment(assign: SyntaxNode): RouterDecl | null {
  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');

  if (left?.type !== 'identifier' || right?.type !== 'call') return null;
  const ctor = right.childForFieldName('function')?.text ?? '';

  if (ROOT_CTOR.test(ctor)) return { name: left.text, root: true, line: line(assign) };

  if (SUB_CTOR.test(ctor)) return { name: left.text, root: false, line: line(assign) };

  return null;
}

/**
 * `app.include_router(items.router, prefix="/items")`,
 * `app.register_blueprint(bp, url_prefix="/x")`, `app.mount("/sub", subapp)`.
 */
function mountFromCall(parent: string, attr: string, call: SyntaxNode): MountDecl | null {
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  const pos = positional(args);

  if (attr === 'include_router' || attr === 'register_blueprint') {
    const child = pos[0];

    if (!child || (child.type !== 'identifier' && child.type !== 'attribute')) return null;
    const p = keyword(args, attr === 'include_router' ? 'prefix' : 'url_prefix');

    return { parent, child: child.text, prefix: p ? (urlParts(p, true) ?? [{ expr: p.text }]) : [], line: line(call) };
  }

  if (attr === 'mount' && pos.length >= 2) {
    const child = keyword(args, 'app') ?? pos[1];

    if (child.type !== 'identifier' && child.type !== 'attribute') return null;

    return { parent, child: child.text, prefix: urlParts(pos[0], true) ?? [], line: line(call) };
  }

  return null;
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
function routerPrefix(assign: SyntaxNode): [string, string, number] | null {
  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');

  if (left?.type !== 'identifier' || right?.type !== 'call') return null;
  const args = right.childForFieldName('arguments')?.namedChildren ?? [];
  const v = stringValue(keyword(args, 'prefix') ?? keyword(args, 'url_prefix'));

  return v != null ? [left.text, v, line(assign)] : null;
}

/** `@router.get("/x")`, `@app.route("/x", methods=["GET", "POST"])`: one route per method. */
function routesFromDecorator(dec: SyntaxNode, prefixes: Map<string, [string, number]>): RouteDecl[] {
  const call = dec.namedChildren.find((c) => c.type === 'call');
  const fn = call?.childForFieldName('function');

  if (!call || fn?.type !== 'attribute') return [];
  const obj = fn.childForFieldName('object')?.text ?? '';
  const attr = fn.childForFieldName('attribute')?.text ?? '';

  if (!ROUTE_ATTRS.has(attr)) return [];
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  const path = stringValue(positional(args)[0] ?? null);

  if (path == null) return [];
  let methods = [HTTP_VERBS.has(attr) ? attr.toUpperCase() : attr === 'websocket' ? 'WS' : attr === 'route' ? 'GET' : '*'];
  const listed = (keyword(args, 'methods')?.namedChildren ?? []).map((m) => stringValue(m)?.toUpperCase()).filter((m): m is string => !!m);

  if (listed.length) methods = listed;
  const prefix = prefixes.get(obj);

  return methods.map((method) => {
    const route: RouteDecl = { method, path: joinPath(prefix?.[0] ?? '', path), line: line(call), router: obj };

    if (prefix) route.prefixLine = prefix[1];

    return route;
  });
}

const joinPath = (a: string, b: string) => (a.replace(/\/$/, '') + '/' + b.replace(/^\//, '')).replace(/\/+/g, '/');

/** `NAME = "…"` or `NAME: str = "…"`, as a constant. */
function constantFrom(stmt: SyntaxNode, owner?: string): ConstDecl | null {
  const assign = stmt.type === 'expression_statement' ? stmt.namedChildren.find((c) => c.type === 'assignment') : null;
  const left = assign?.childForFieldName('left');
  const right = assign?.childForFieldName('right');

  if (left?.type !== 'identifier' || right?.type !== 'string') return null;
  const value = stringValue(right);

  if (value == null || value.includes('{}')) return null;

  return owner ? { name: left.text, value, line: line(stmt), owner } : { name: left.text, value, line: line(stmt) };
}

const TYPE_WRAPPERS = new Set(['Mapped', 'WriteOnlyMapped', 'DynamicMapped', 'List', 'Optional', 'Set', 'Dict', 'Union', 'Sequence', 'Tuple']);

/** The entity class an annotation like `so.WriteOnlyMapped['Post']` or `Mapped[list[Note]]` points at. */
function annotatedClass(type: string): string | null {
  const names = [...type.matchAll(/[A-Z]\w*/g)].map((m) => m[0]).filter((n) => !TYPE_WRAPPERS.has(n));

  return names.pop() ?? null;
}

interface ClassBody {
  tableName?: string;
  columns: boolean;
  orm: OrmRef[];
  constants: ConstDecl[];
}

/** What a class body says about persistence: `__tablename__`, mapped columns, relationships and foreign keys. */
function classBody(def: SyntaxNode, name: string): ClassBody {
  const out: ClassBody = { columns: false, orm: [], constants: [] };
  const body = def.childForFieldName('body');

  for (const stmt of body?.namedChildren ?? []) {
    const c = constantFrom(stmt, name);

    if (c) {
      out.constants.push(c);

      if (c.name === '__tablename__') out.tableName = c.value;
    }

    const assign = stmt.type === 'expression_statement' ? stmt.namedChildren.find((x) => x.type === 'assignment') : null;

    if (!assign) continue;
    const type = assign.childForFieldName('type')?.text ?? '';

    if (type.startsWith('Mapped[')) out.columns = true;

    for (const call of assign.descendantsOfType('call')) {
      const fn = call.childForFieldName('function')?.text ?? '';
      const args = call.childForFieldName('arguments')?.namedChildren ?? [];

      if (COLUMN_CALL.test(fn)) out.columns = true;

      if (/(^|\.)relationship$/.test(fn)) {
        const target = positional(args)[0];
        // relationship("Note"), relationship(Note), or only the annotation: `posts: Mapped[list["Post"]] = relationship(...)`.
        const cls = target?.type === 'string' ? stringValue(target) : target?.type === 'identifier' ? target.text : annotatedClass(type);

        if (cls) out.orm.push({ kind: 'relationship', target: cls.split('.').pop()!, line: line(call) });
      } else if (/(^|\.)ForeignKey$/.test(fn)) {
        // ForeignKey("users.id") names a table; ForeignKey(User.id) names the class.
        const arg = positional(args)[0];
        const fk = arg?.type === 'attribute' ? arg.text : stringValue(arg ?? null);

        if (fk) out.orm.push({ kind: 'foreign-key', target: fk, line: line(call) });
      } else if (/(^|\.)Field$/.test(fn)) {
        const fk = stringValue(keyword(args, 'foreign_key'));

        if (fk) out.orm.push({ kind: 'foreign-key', target: fk, line: line(call) });
      }
    }
  }

  return out;
}

export function extractPython(root: SyntaxNode, file: ParsedFile) {
  const fileRefs = new RefSet();
  const prefixes = new Map<string, [string, number]>();

  // Router prefixes first: decorators below refer to them.
  for (const n of root.namedChildren) {
    if (n.type !== 'expression_statement') continue;
    const assign = n.namedChildren.find((c) => c.type === 'assignment');
    const p = assign && routerPrefix(assign);

    if (p) prefixes.set(p[0], [p[1], p[2]]);
    const c = constantFrom(n);

    if (c) file.constants.push(c);
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

        // Imports inside functions (lazy imports in app factories) bind names too.
        for (const imp of def.descendantsOfType(['import_statement', 'import_from_statement'])) file.imports.push(...parseImport(imp));
        const decorators: string[] = [];
        const routes: RouteDecl[] = [];

        if (n.type === 'decorated_definition') {
          for (const d of n.namedChildren) {
            if (d.type !== 'decorator') continue;
            const expr = d.namedChildren[0];
            decorators.push((expr?.type === 'call' ? expr.childForFieldName('function')?.text : expr?.text) ?? '');
            routes.push(...routesFromDecorator(d, prefixes));
          }
        }

        let kind: SymbolKind = def.type === 'class_definition' ? 'class' : 'function';
        let bases: string[] | undefined;
        let body: ClassBody | undefined;

        if (def.type === 'class_definition') {
          // Keep keyword arguments too ("table=True" marks a SQLModel table).
          bases = (def.childForFieldName('superclasses')?.namedChildren ?? [])
            .filter((b) => b.type === 'identifier' || b.type === 'attribute' || b.type === 'keyword_argument')
            .map((b) => b.text.replace(/\s+/g, ''));

          if (bases.some((b) => ENUM_BASES.test(b))) kind = 'enum';
          else if (bases.some((b) => INTERFACE_BASES.test(b))) kind = 'interface';
          body = classBody(def, name);
          file.constants.push(...body.constants);
        }

        const s = scan(n, name);

        for (const b of bases ?? []) if (/^[A-Za-z_]\w*$/.test(b)) s.refs.add(b, 'type', line(def));

        const params =
          def.type === 'function_definition'
            ? (def.childForFieldName('parameters')?.namedChildren ?? []).map((p) => (p.type === 'identifier' ? p.text : (p.namedChildren[0]?.type === 'identifier' ? p.namedChildren[0].text : '')))
            : undefined;

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
          routers: s.routers.length ? s.routers : undefined,
          mounts: s.mounts.length ? s.mounts : undefined,
          params: params?.length ? params : undefined,
          tableName: body?.tableName,
          columns: body?.columns || undefined,
          orm: body?.orm.length ? body.orm : undefined,
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
  into.merge(s.refs.list());
  file.requests.push(...s.requests);
  file.routers.push(...s.routers);
  file.mounts.push(...s.mounts);
}
