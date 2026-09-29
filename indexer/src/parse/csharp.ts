// C# fact extraction: namespaces, usings, types and their methods, and the
// routes of ASP.NET controllers (`[Route]`, `[HttpGet]`) and minimal APIs
// (`app.MapGet("/x", …)`).

import type { ImportSpec, ParsedFile, RouteDecl } from '../model.ts';
import { annotationRoutes, capitalized, innermost, joinPath, keywords, literal, methodsIn, outline, type Ann, type Decl, type LangSpec, type RefSink } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const TYPE_KIND = {
  class_declaration: 'class',
  record_declaration: 'class',
  record_struct_declaration: 'class',
  struct_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  delegate_declaration: 'type',
} as const;

const MAP_VERB: Record<string, string> = { MapGet: 'GET', MapPost: 'POST', MapPut: 'PUT', MapDelete: 'DELETE', MapPatch: 'PATCH', Map: '*', MapMethods: '*' };

const lastSegment = (s: string) => s.slice(s.lastIndexOf('.') + 1);
const isPrivate = (n: SyntaxNode) => n.namedChildren.some((c) => c.type === 'modifier' && c.text === 'private');

function attributes(n: SyntaxNode): Ann[] {
  const out: Ann[] = [];
  for (const list of n.namedChildren.filter((c) => c.type === 'attribute_list')) {
    for (const a of list.namedChildren.filter((c) => c.type === 'attribute')) {
      const name = lastSegment(a.childForFieldName('name')?.text ?? '').replace(/Attribute$/, '');
      // A route template attribute has one template.
      const template = a.descendantsOfType(['string_literal', 'verbatim_string_literal']).map((s) => literal(s)).find((s) => s != null);
      out.push({ name, paths: template != null ? [template] : [], methods: methodsIn(a.text), line: line(a) });
    }
  }
  return out;
}

const enclosingType = (n: SyntaxNode) => {
  for (let p = n.parent; p; p = p.parent) if (p.type in TYPE_KIND) return p;
  return null;
};

const typeName = (n: SyntaxNode | null | undefined): string | null => {
  if (!n) return null;
  if (n.type === 'identifier') return n.text;
  if (n.type === 'generic_name') return n.namedChildren[0]?.text ?? null;
  if (n.type === 'qualified_name') return typeName(n.namedChildren[n.namedChildren.length - 1]);
  return null;
};

/** `External.Models.Item` keeps what qualifies it, a namespace or an outer type, for the linker to look in. */
function addQualified(out: RefSink, n: SyntaxNode, kind: 'new' | 'type', at: SyntaxNode) {
  for (const id of n.descendantsOfType('identifier')) out.seen(id);
  const parts = n.text.replace(/^global::/, '').replace(/<.*$/s, '').split('.').map((p) => p.trim());
  out.add(parts[parts.length - 1], kind, at, undefined, parts.slice(0, -1).join('.'));
}

const spec: LangSpec = {
  decl(n): Decl | null {
    if (n.type === 'using_directive') return { as: 'skip' };
    if (n.type === 'namespace_declaration') return { as: 'scope', body: n.childForFieldName('body') };
    if (n.type === 'file_scoped_namespace_declaration') return { as: 'scope' };
    if (n.type in TYPE_KIND) {
      const name = n.childForFieldName('name')?.text;
      if (!name) return null;
      const bases = (n.childForFieldName('bases') ?? n.namedChildren.find((c) => c.type === 'base_list'))?.namedChildren.map(typeName).filter((b): b is string => !!b) ?? [];
      return {
        as: 'type',
        kind: TYPE_KIND[n.type as keyof typeof TYPE_KIND],
        name,
        body: n.childForFieldName('body'),
        exported: !isPrivate(n),
        bases,
        decorators: attributes(n).map((a) => a.name),
      };
    }
    if (n.type === 'method_declaration') {
      const name = n.childForFieldName('name')?.text;
      if (!name) return null;
      const owner = enclosingType(n);
      const own = attributes(n);
      const routes = annotationRoutes(own, owner ? attributes(owner) : [], n, { type: owner?.childForFieldName('name')?.text, method: name });
      return { as: 'function', kind: 'function', name, exported: !isPrivate(n), decorators: own.map((a) => a.name), routes };
    }
    return null;
  },
  ref(n, out) {
    switch (n.type) {
      case 'invocation_expression': {
        const fn = n.childForFieldName('function');
        if (fn?.type === 'identifier' || fn?.type === 'generic_name') {
          out.seen(fn);
          out.seen(fn.namedChildren[0]);
          out.add(typeName(fn)!, 'call', n);
        } else if (fn?.type === 'member_access_expression') {
          const expr = fn.childForFieldName('expression');
          const name = typeName(fn.childForFieldName('name'));
          out.seen(fn);
          out.seen(fn.childForFieldName('name'));
          if (!name) return;
          if (expr?.type === 'this_expression') out.self(name, 'call', n);
          else if (expr?.type === 'identifier') {
            out.seen(expr);
            out.add(expr.text, 'call', n, name);
          } else if (expr?.type === 'member_access_expression' && /^[A-Z][\w.]*$/.test(expr.text.replace(/\s+/g, ''))) {
            // `External.Models.Util.Run()`, `Outer.Inner.Create()`: the type, what qualifies it, and the method.
            const parts = expr.text.replace(/\s+/g, '').split('.');
            for (const id of expr.descendantsOfType('identifier')) out.seen(id);
            out.add(parts[parts.length - 1], 'call', n, name, parts.slice(0, -1).join('.'));
          }
        }
        return;
      }
      case 'object_creation_expression': {
        const type = n.childForFieldName('type');
        const name = typeName(type);
        if (type?.type === 'qualified_name') {
          out.seen(type);
          addQualified(out, type, 'new', n);
        } else if (name) {
          out.seen(type);
          out.seen(type?.namedChildren[0]);
          out.add(name, 'new', n);
        }
        return;
      }
      case 'member_access_expression': {
        const expr = n.childForFieldName('expression');
        const name = n.childForFieldName('name');
        out.seen(name);
        if (expr?.type === 'this_expression' && name) out.self(name.text, 'ref', n);
        else if (expr?.type === 'identifier' && name && capitalized(expr.text)) {
          out.seen(expr);
          out.add(expr.text, 'ref', n, name.text);
        }
        return;
      }
      case 'attribute': {
        const name = n.childForFieldName('name');
        out.seen(name);
        if (name) out.add(lastSegment(name.text), 'type', n);
        return;
      }
      case 'qualified_name':
        if (!n.parent?.type.endsWith('namespace_declaration')) addQualified(out, n, 'type', n);
        return true;
      case 'identifier': {
        if (!capitalized(n.text) || n.parent?.type.endsWith('namespace_declaration')) return;
        const p = n.parent;
        const isType = p?.type === 'base_list' || p?.type === 'type_argument_list' || p?.childForFieldName('type')?.id === n.id;
        out.add(n.text, isType ? 'type' : 'ref', n);
        return;
      }
    }
  },
};

const LOCAL_SCOPE = new Set(['method_declaration', 'constructor_declaration', 'local_function_statement', 'lambda_expression', 'anonymous_method_expression']);

/**
 * Minimal-API routes: `app.MapGet("/items/{id}", …)`, with the prefix of a
 * `var api = app.MapGroup("/api")` they're called on. A group variable is
 * local to the method (or lambda) declaring it; its line is the prefix's evidence.
 */
function minimalApiRoutes(root: SyntaxNode): RouteDecl[] {
  const groups = new Map<string, { path: string; line: number }>();
  const scopesOf = (n: SyntaxNode) => {
    const out: number[] = [];
    for (let p = n.parent; p; p = p.parent) if (LOCAL_SCOPE.has(p.type)) out.push(p.id);
    return [...out, root.id];
  };
  const group = (n: SyntaxNode, name: string) => scopesOf(n).map((s) => groups.get(`${s}:${name}`)).find(Boolean);
  for (const d of root.descendantsOfType('variable_declarator')) {
    const call = d.descendantsOfType('invocation_expression')[0];
    const fn = call?.childForFieldName('function');
    if (fn?.type !== 'member_access_expression' || fn.childForFieldName('name')?.text !== 'MapGroup') continue;
    const name = d.namedChildren[0]?.text;
    const p = literal(call!.childForFieldName('arguments')?.descendantsOfType('string_literal')[0]);
    const parent = group(d, fn.childForFieldName('expression')?.text ?? '')?.path ?? '';
    if (name && p != null) groups.set(`${scopesOf(d)[0]}:${name}`, { path: joinPath(parent, p), line: line(d) });
  }
  const out: RouteDecl[] = [];
  for (const call of root.descendantsOfType('invocation_expression')) {
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'member_access_expression') continue;
    const mapper = fn.childForFieldName('name')?.text ?? '';
    const verb = MAP_VERB[mapper];
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    const first = args[0]?.namedChildren[0];
    const p = first?.type === 'string_literal' ? literal(first) : null;
    if (!verb || p == null) continue;
    // `MapMethods("/x", new[] { "GET", "PUT" }, …)` names its verbs; any others it may name are unknown here.
    const listed = mapper === 'MapMethods' ? [...new Set(methodsIn((args[1]?.text ?? '').toUpperCase()))] : [];
    const g = group(call, fn.childForFieldName('expression')?.text ?? '');
    for (const method of listed.length ? listed : [verb]) {
      out.push(g ? { method, path: joinPath(g.path, p), line: line(call), prefixLine: g.line } : { method, path: joinPath('', p), line: line(call) });
    }
  }
  return out;
}

export function extractCSharp(root: SyntaxNode, file: ParsedFile) {
  // Every namespace, nested ones by their full name, and the lines it spans; a file-scoped one runs to the end.
  const spans = root.descendantsOfType(['namespace_declaration', 'file_scoped_namespace_declaration']).flatMap((n) => {
    const own = n.childForFieldName('name')?.text;
    if (!own) return [];
    const outer: string[] = [];
    for (let p = n.parent; p; p = p.parent) {
      if (p.type === 'namespace_declaration') outer.unshift(p.childForFieldName('name')?.text ?? '');
    }
    const end = n.type === 'file_scoped_namespace_declaration' ? root.endPosition.row + 1 : n.endPosition.row + 1;
    return [{ name: [...outer, own].filter(Boolean).join('.'), start: line(n), end }];
  });
  if (spans.length) file.namespaces = [...new Set(spans.map((s) => s.name))];
  // A using inside a namespace block is seen only by the code in that block.
  const blocks = root.descendantsOfType('namespace_declaration').map((n) => ({ start: line(n), end: n.endPosition.row + 1, specs: [] as ImportSpec[] }));
  for (const u of root.descendantsOfType('using_directive')) {
    const target = u.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'identifier');
    if (!target) continue;
    const alias = u.namedChildren.find((c) => c.type === 'name_equals')?.namedChildren[0]?.text;
    // `using static A.B.C;` opens a type, whose members are "C.x" here.
    const s: ImportSpec = alias
      ? { source: target.text, level: 0, names: [{ imported: lastSegment(target.text), local: alias }], line: line(u) }
      : { source: target.text, level: 0, names: [], open: true, line: line(u) };
    if (keywords(u).includes('global')) s.global = true;
    const block = u.parent?.parent?.type === 'namespace_declaration' ? innermost(blocks, line(u)) : undefined;
    (block ? block.specs : file.imports).push(s);
  }
  outline(root, spec, file);
  for (const sym of file.symbols) {
    const inside = innermost(spans, sym.lines[0], sym.lines[1]);
    if (inside) sym.namespace = inside.name;
    const specs = blocks.filter((b) => b.start <= sym.lines[0] && sym.lines[1] <= b.end).flatMap((b) => b.specs);
    if (specs.length) sym.imports = specs;
  }
  // Routes mapped in top-level statements or a Program.Main belong to the file.
  const mapped = minimalApiRoutes(root);
  if (mapped.length) file.routes.push(...mapped);
}
