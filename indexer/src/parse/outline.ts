// The shared walk for languages whose files are mostly declarations: Java,
// Kotlin, C#, Rust, C, C++, Ruby and Swift. Each language says what a node
// declares and what it refers to; this turns that into symbols (types, and
// their methods as "Type.method", as Go does) and the refs each one makes.

import type { SymbolKind } from '@fiada/shared';
import type { ParsedFile, ParsedSymbol, RefKind, RouteDecl } from '../model.ts';
import { RefSet } from './refs.ts';
import { line, type SyntaxNode } from './treesitter.ts';

/** What a node declares. */
export type Decl =
  /** Becomes a symbol; a type's members are walked with its name as their owner. */
  | {
      as: 'type' | 'function' | 'variable';
      kind: SymbolKind;
      name: string;
      /** Where a type's members are; the node itself when unset. */
      body?: SyntaxNode | null;
      /** Owner named by the declaration itself (C++ `void Foo::bar() {}`), in place of the enclosing one. */
      owner?: string;
      exported?: boolean;
      bases?: string[];
      decorators?: string[];
      routes?: RouteDecl[];
    }
  /** Walked through: namespaces, impl blocks, extensions, preprocessor conditionals. `owner` replaces the enclosing owner. */
  | { as: 'scope'; body?: SyntaxNode | null; owner?: string }
  /** Ignored: imports and package lines, read separately. */
  | { as: 'skip' };

/** Stands for `this`/`self` in a ref, until the walk knows which type a method belongs to. */
export const SELF = '@self';

export interface RefSink {
  /** `scope`: the namespace a C++ qualified name gives. */
  add(name: string, kind: RefKind, n: SyntaxNode, member?: string, scope?: string): void;
  /** `this.member` / `self.member`: a sibling member of the enclosing type. */
  self(member: string, kind: RefKind, n: SyntaxNode): void;
  /** Mark a node as accounted for, so it isn't read again as a bare identifier. */
  seen(n: SyntaxNode | null | undefined): void;
  wasSeen(n: SyntaxNode): boolean;
}

export interface LangSpec {
  decl(n: SyntaxNode, owner: string | null): Decl | null;
  /** Record what `n` refers to; return true to skip its subtree. */
  ref(n: SyntaxNode, out: RefSink): boolean | void;
  /** How a member's name joins its owner's; "Owner.name" by default. */
  join?(owner: string, name: string, as: 'type' | 'function' | 'variable'): string;
}

const defaultJoin = (owner: string, name: string) => `${owner}.${name}`;

/** Walk a file's declarations into `file.symbols` and `file.fileRefs`. */
export function outline(root: SyntaxNode, spec: LangSpec, file: ParsedFile) {
  const join = spec.join ?? defaultJoin;
  const fileRefs = new RefSet();
  const owners: (string | null)[] = [];

  const collect = (node: SyntaxNode, refs: RefSet, owner: string | null, membersApart: boolean) => {
    const seen = new Set<number>();
    const sink: RefSink = {
      add: (name, kind, n, member, scope) => {
        seen.add(n.id);
        refs.add(name, kind, line(n), member, scope);
      },
      self: (member, kind, n) => {
        seen.add(n.id);
        refs.add(SELF, kind, line(n), member);
      },
      seen: (n) => {
        if (n) seen.add(n.id);
      },
      wasSeen: (n) => seen.has(n.id),
    };
    const walk = (n: SyntaxNode) => {
      if (membersApart && n.id !== node.id) {
        const d = spec.decl(n, owner);
        if (d && d.as !== 'scope') return;
      }
      if (!seen.has(n.id) && spec.ref(n, sink) === true) return;
      for (const c of n.namedChildren) walk(c);
    };
    walk(node);
  };

  const visit = (node: SyntaxNode, owner: string | null) => {
    for (const child of node.namedChildren) {
      const d = spec.decl(child, owner);
      if (!d) {
        if (owner == null) collect(child, fileRefs, null, false);
        continue;
      }
      if (d.as === 'skip') continue;
      if (d.as === 'scope') {
        visit(d.body ?? child, d.owner ?? owner);
        continue;
      }
      const base = d.owner ?? owner;
      const name = base ? join(base, d.name, d.as) : d.name;
      const refs = new RefSet(d.name);
      collect(child, refs, name, d.as === 'type');
      const sym: ParsedSymbol = {
        name,
        kind: d.kind,
        exported: d.exported ?? true,
        lines: [line(child), child.endPosition.row + 1],
        refs: refs.list(),
      };
      if (d.bases?.length) sym.bases = d.bases;
      if (d.decorators?.length) sym.decorators = d.decorators;
      if (d.routes?.length) sym.routes = d.routes;
      file.symbols.push(sym);
      owners.push(d.as === 'type' ? null : base);
      if (d.as === 'type') visit(d.body ?? child, name);
    }
  };
  visit(root, null);

  // `this.helper()` and a bare `helper()` inside a method name a sibling member.
  // When the type is declared elsewhere (a Swift extension, a Rust impl, a C++
  // `Foo::bar` definition), `self.x` points at that type.
  const names = new Set(file.symbols.map((s) => s.name));
  file.symbols.forEach((s, i) => {
    const owner = owners[i];
    s.refs = s.refs.flatMap((r) => {
      if (r.name === SELF) {
        if (!owner || !r.member) return [];
        const sibling = join(owner, r.member, 'function');
        if (names.has(sibling)) return sibling !== s.name ? [{ name: sibling, kind: r.kind, line: r.line }] : [];
        return names.has(owner) ? [] : [{ name: owner, member: r.member, kind: r.kind, line: r.line }];
      }
      if (!r.member && owner) {
        const sibling = join(owner, r.name, 'function');
        if (r.scope == null && names.has(sibling) && sibling !== s.name) return [{ ...r, name: sibling }];
      }
      return [r];
    });
  });
  file.fileRefs = fileRefs.list().filter((r) => r.name !== SELF);
}

/** The innermost of `spans` holding lines `a` to `b`. */
export function innermost<T extends { start: number; end: number }>(spans: T[], a: number, b = a): T | undefined {
  return spans.filter((s) => s.start <= a && b <= s.end).sort((x, y) => y.start - x.start || x.end - y.end)[0];
}

/** The innermost function symbol whose body holds `at`, to own an import declared there. */
export function enclosingFunction(file: ParsedFile, at: number): ParsedSymbol | undefined {
  return innermost(file.symbols.filter((s) => s.kind === 'function').map((s) => ({ start: s.lines[0], end: s.lines[1], s })), at)?.s;
}

/** Text of a string literal without its quotes, or null when it has interpolations. */
export function literal(n: SyntaxNode | null | undefined): string | null {
  if (!n) return null;
  let out = '';
  let parts = false;
  for (const c of n.namedChildren) {
    if (c.type === 'string_fragment' || c.type === 'string_content' || c.type === 'escape_sequence' || c.type === 'line_str_text' || c.type === 'string_literal_content') {
      out += c.text;
      parts = true;
    } else if (/interpolation|substitution|line_str_expr|string_interpolation/.test(c.type)) return null;
  }
  if (parts) return out;
  const m = n.text.match(/^@?\$?(["'`])([\s\S]*)\1$/);
  return m ? m[2] : null;
}

/** Names that are types or constants by convention, so worth recording as bare identifiers. */
export const capitalized = (s: string) => /^[A-Z]/.test(s);

/** The first named child of one of `types`. */
export const childOf = (n: SyntaxNode | null | undefined, ...types: string[]) => n?.namedChildren.find((c) => types.includes(c.type)) ?? null;

/** The anonymous keyword children of a node ("class", "interface", "static", …). */
export const keywords = (n: SyntaxNode) => n.children.filter((c) => !c.isNamed()).map((c) => c.type);

/** An annotation or attribute: `@GetMapping({"/x", "/y"})`, `[HttpGet("{id}")]`, with the paths and HTTP methods it names. */
export interface Ann {
  name: string;
  paths: string[];
  methods: string[];
  line: number;
}

const VERB_ANNOTATION: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
  HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH', HttpHead: 'HEAD', HttpOptions: 'OPTIONS',
};
const JAXRS_VERB = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/;
const PATH_ANNOTATION = /^(RequestMapping|Path|Route)$/;

/** HTTP methods named in an annotation argument: `RequestMethod.POST`, `{GET, PUT}`. */
export const methodsIn = (text: string) => [...text.matchAll(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map((m) => m[1]);

/**
 * Routes a method declares through annotations: Spring (`@GetMapping`,
 * `@RequestMapping`), JAX-RS (`@GET` with `@Path`) and ASP.NET (`[HttpGet]`,
 * `[Route]`), under its class's own `@RequestMapping`/`@Path`/`[Route]`.
 */
export function annotationRoutes(own: Ann[], outer: Ann[], n: SyntaxNode, names: { type?: string; method?: string } = {}): RouteDecl[] {
  const fill = (p: string) =>
    p.replace(/\[controller\]/gi, (names.type ?? '').replace(/Controller$/, '')).replace(/\[action\]/gi, names.method ?? '');
  // Every path the class maps, each with every path the method maps; the class's annotation is the prefix's evidence.
  const outerAnn = outer.find((a) => PATH_ANNOTATION.test(a.name));
  const prefixes = outerAnn?.paths.length ? outerAnn.paths : [''];
  const ownPaths = own.find((a) => PATH_ANNOTATION.test(a.name) && a.name !== 'RequestMapping')?.paths ?? [];
  const out: RouteDecl[] = [];
  const add = (method: string, paths: string[], dotnet = false) => {
    for (const p of paths.length ? paths : ['']) {
      for (const prefix of prefixes) {
        const absolute = dotnet && /^~?\//.test(p);
        const full = joinPath(absolute ? '' : fill(prefix), fill(p.replace(/^~/, '')));
        if (out.some((r) => r.method === method && r.path === full)) continue;
        out.push(!absolute && prefix && outerAnn ? { method, path: full, line: line(n), prefixLine: outerAnn.line } : { method, path: full, line: line(n) });
      }
    }
  };
  for (const a of own) {
    const verb = VERB_ANNOTATION[a.name];
    if (verb) add(verb, a.paths.length ? a.paths : ownPaths, a.name.startsWith('Http'));
    else if (a.name === 'RequestMapping') for (const m of a.methods.length ? a.methods : ['*']) add(m, a.paths);
    else if (JAXRS_VERB.test(a.name)) add(a.name, ownPaths);
  }
  return out;
}

export function joinPath(a: string, b: string): string {
  const out = `/${a.replace(/^\/+|\/+$/g, '')}/${b.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return out.length > 1 ? out.replace(/\/$/, '') : out;
}
