// Java fact extraction: package, imports, types and their methods, and the
// routes of Spring (`@GetMapping`, `@RequestMapping`) and JAX-RS (`@GET`, `@Path`).

import type { ParsedFile } from '../model.ts';
import { annotationRoutes, capitalized, keywords, literal, methodsIn, outline, type Ann, type Decl, type LangSpec, type RefSink } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const TYPE_KIND = {
  class_declaration: 'class',
  record_declaration: 'class',
  interface_declaration: 'interface',
  annotation_type_declaration: 'interface',
  enum_declaration: 'enum',
} as const;

const modifiers = (n: SyntaxNode) => n.namedChildren.find((c) => c.type === 'modifiers') ?? null;
const lastSegment = (s: string) => s.slice(s.lastIndexOf('.') + 1);

function annotations(n: SyntaxNode): Ann[] {
  return (modifiers(n)?.namedChildren ?? [])
    .filter((c) => c.type === 'annotation' || c.type === 'marker_annotation')
    .map((a) => {
      const paths: string[] = [];
      let methods: string[] = [];
      for (const arg of a.childForFieldName('arguments')?.namedChildren ?? []) {
        if (arg.type === 'element_value_pair') {
          const key = arg.childForFieldName('key')?.text;
          const value = arg.childForFieldName('value');
          if (key === 'method') methods = methodsIn(value?.text ?? '');
          else if (key === 'value' || key === 'path') paths.push(...strings(value));
        } else paths.push(...strings(arg));
      }
      return { name: lastSegment(a.childForFieldName('name')?.text ?? ''), paths: [...new Set(paths)], methods, line: line(a) };
    });
}

/** `"/x"` or `{"/x", "/y"}` → every path. */
const strings = (n: SyntaxNode | null | undefined): string[] =>
  !n ? [] : (n.type === 'string_literal' ? [n] : n.descendantsOfType('string_literal')).map((s) => literal(s)).filter((s): s is string => s != null);

const isPrivate = (n: SyntaxNode) => !!modifiers(n) && keywords(modifiers(n)!).includes('private');

function bases(n: SyntaxNode): string[] {
  const out: string[] = [];
  for (const field of ['superclass', 'interfaces']) {
    for (const t of n.childForFieldName(field)?.descendantsOfType(['type_identifier', 'scoped_type_identifier']) ?? []) {
      if (t.parent?.type !== 'scoped_type_identifier') out.push(lastSegment(t.text));
    }
  }
  // interface I extends A, B
  for (const c of n.namedChildren) {
    if (c.type === 'extends_interfaces') for (const t of c.descendantsOfType('type_identifier')) out.push(t.text);
  }
  return out;
}

/** The type declaration a member sits in. */
const enclosingType = (n: SyntaxNode) => {
  for (let p = n.parent; p; p = p.parent) if (p.type in TYPE_KIND) return p;
  return null;
};

/**
 * `Outer.Inner` keeps its qualifier, to reach the nested type's own symbol,
 * and `external.api.Widget` its package, which the linker looks in rather
 * than for any Widget in sight.
 */
function addType(out: RefSink, id: SyntaxNode, kind: 'new' | 'type', at: SyntaxNode) {
  for (const t of id.descendantsOfType('type_identifier')) out.seen(t);
  const parts = id.text.replace(/<.*$/s, '').split('.').map((p) => p.trim());
  const first = parts.findIndex((p) => /^[A-Z]/.test(p));
  if (first < 0) return void out.add(parts[parts.length - 1], kind, at);
  const scope = first > 0 ? parts.slice(0, first).join('.') : undefined;
  out.add(parts[first], kind, at, parts.slice(first + 1).join('.') || undefined, scope);
}

const spec: LangSpec = {
  decl(n): Decl | null {
    if (n.type === 'package_declaration' || n.type === 'import_declaration') return { as: 'skip' };
    if (n.type in TYPE_KIND) {
      const name = n.childForFieldName('name')?.text;
      if (!name) return null;
      return {
        as: 'type',
        kind: TYPE_KIND[n.type as keyof typeof TYPE_KIND],
        name,
        body: n.childForFieldName('body'),
        exported: !isPrivate(n),
        bases: bases(n),
        decorators: annotations(n).map((a) => a.name),
      };
    }
    if (n.type === 'method_declaration') {
      const name = n.childForFieldName('name')?.text;
      if (!name) return null;
      const owner = enclosingType(n);
      const own = annotations(n);
      const routes = annotationRoutes(own, owner ? annotations(owner) : [], n);
      return { as: 'function', kind: 'function', name, exported: !isPrivate(n), decorators: own.map((a) => a.name), routes };
    }
    return null;
  },
  ref(n, out) {
    switch (n.type) {
      case 'method_invocation': {
        const name = n.childForFieldName('name');
        const obj = n.childForFieldName('object');
        if (!name) return;
        out.seen(name);
        if (!obj) out.add(name.text, 'call', n);
        else if (obj.type === 'this') out.self(name.text, 'call', n);
        else if (obj.type === 'identifier') {
          out.seen(obj);
          out.add(obj.text, 'call', n, name.text);
        } else if (obj.type === 'field_access' && /^[\w.]+$/.test(obj.text.replace(/\s+/g, ''))) {
          // `a.b.Util.run()`, `Outer.Inner.make()`: the package, the type and the rest.
          const parts = obj.text.replace(/\s+/g, '').split('.');
          const first = parts.findIndex((p) => /^[A-Z]/.test(p));
          if (first < 0) return;
          for (const id of obj.descendantsOfType('identifier')) out.seen(id);
          out.add(parts[first], 'call', n, [...parts.slice(first + 1), name.text].join('.'), first > 0 ? parts.slice(0, first).join('.') : undefined);
        }
        return;
      }
      case 'object_creation_expression': {
        const type = n.childForFieldName('type');
        const id = type?.type === 'generic_type' ? type.namedChildren[0] : type;
        if (id && (id.type === 'type_identifier' || id.type === 'scoped_type_identifier')) {
          out.seen(id);
          addType(out, id, 'new', n);
        }
        return;
      }
      case 'field_access': {
        const obj = n.childForFieldName('object');
        const field = n.childForFieldName('field');
        out.seen(field);
        if (obj?.type === 'identifier' && field) {
          out.seen(obj);
          if (capitalized(obj.text)) out.add(obj.text, 'ref', n, field.text);
        } else if (obj?.type === 'this' && field) out.self(field.text, 'ref', n);
        return;
      }
      case 'method_reference': {
        const [obj, member] = n.namedChildren;
        if (obj?.type === 'identifier' && member?.type === 'identifier') {
          out.seen(obj);
          out.seen(member);
          out.add(obj.text, 'ref', n, member.text);
        }
        return;
      }
      case 'scoped_type_identifier':
        addType(out, n, 'type', n);
        return true;
      case 'type_identifier':
        out.add(n.text, 'type', n);
        return;
      case 'marker_annotation':
      case 'annotation': {
        const name = n.childForFieldName('name');
        out.seen(name);
        if (name) out.add(lastSegment(name.text), 'type', n);
        return;
      }
      case 'identifier':
        if (capitalized(n.text)) out.add(n.text, 'ref', n);
        return;
    }
  },
};

export function extractJava(root: SyntaxNode, file: ParsedFile) {
  for (const n of root.namedChildren) {
    if (n.type === 'package_declaration') {
      const name = n.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')?.text;
      if (name) file.namespaces = [name];
    } else if (n.type === 'import_declaration') {
      const path = n.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')?.text;
      if (!path) continue;
      const wildcard = n.namedChildren.some((c) => c.type === 'asterisk');
      if (wildcard) file.imports.push({ source: path, level: 0, names: [], open: true, line: line(n) });
      else file.imports.push({ source: path, level: 0, names: [{ imported: lastSegment(path), local: lastSegment(path) }], line: line(n) });
    }
  }
  outline(root, spec, file);
}
