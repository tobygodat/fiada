// Kotlin fact extraction: package, imports, classes, objects, interfaces and
// their functions, top-level functions and properties, and Spring routes.
// The grammar has few named fields, so declarations are read by child type.

import type { ParsedFile } from '../model.ts';
import { annotationRoutes, capitalized, childOf, keywords, literal, methodsIn, outline, type Ann, type Decl, type LangSpec, type RefSink } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const nameOf = (n: SyntaxNode, type: string) => childOf(n, type)?.text ?? null;

const isPrivate = (n: SyntaxNode) => !!childOf(n, 'modifiers')?.descendantsOfType('visibility_modifier').some((v) => v.text === 'private');

function annotation(a: SyntaxNode): Ann {
  const ctor = childOf(a, 'constructor_invocation');
  const name = (ctor ? childOf(ctor, 'user_type') : childOf(a, 'user_type'))?.text ?? '';
  const paths: string[] = [];
  let methods: string[] = [];
  for (const arg of childOf(ctor, 'value_arguments')?.namedChildren ?? []) {
    const [first, second] = arg.namedChildren;
    const key = second && first?.type === 'simple_identifier' ? first.text : null;
    const value = key ? second : first;
    if (key === 'method') methods = methodsIn(value?.text ?? '');
    else if (!key || key === 'value' || key === 'path') paths.push(...strings(value));
  }
  // A detached `@RequestMapping("/api")` the grammar reads as a prefix expression.
  if (!ctor && a.nextNamedSibling?.type === 'parenthesized_expression') paths.push(...strings(a.nextNamedSibling));
  return { name: name.slice(name.lastIndexOf('.') + 1), paths: [...new Set(paths)], methods, line: line(a) };
}

/** `"/x"` or `["/x", "/y"]` → every path. */
const strings = (n: SyntaxNode | null | undefined): string[] =>
  !n ? [] : (n.type === 'string_literal' ? [n] : n.descendantsOfType('string_literal')).map((s) => literal(s)).filter((s): s is string => s != null);

/** Annotations on a declaration, and those the grammar leaves in a prefix expression just before it. */
function annotations(n: SyntaxNode): Ann[] {
  const own = (childOf(n, 'modifiers')?.namedChildren ?? []).filter((c) => c.type === 'annotation');
  const before: SyntaxNode[] = [];
  for (let p = n.previousNamedSibling; p?.type === 'prefix_expression' || p?.type === 'annotation'; p = p.previousNamedSibling) {
    before.push(...(p.type === 'annotation' ? [p] : p.descendantsOfType('annotation')));
  }
  return [...before, ...own].map(annotation);
}

const enclosingClass = (n: SyntaxNode) => {
  for (let p = n.parent; p; p = p.parent) if (p.type === 'class_declaration' || p.type === 'object_declaration') return p;
  return null;
};

/**
 * `external.api.Widget()` or `external.api.Util.run()`: the package, the
 * type (or function) and any member, for the linker to look for in that
 * package. A chain through calls (`a().b()`) names no package.
 */
function addQualified(out: RefSink, callee: SyntaxNode, at: SyntaxNode) {
  for (const id of callee.descendantsOfType('simple_identifier')) out.seen(id);
  const text = callee.text.replace(/\s+/g, '');
  if (!/^[\w.]+$/.test(text)) return;
  const parts = text.split('.');
  const first = parts.findIndex((p) => /^[A-Z]/.test(p));
  const at0 = first < 0 ? parts.length - 1 : first;
  if (at0 === 0) return;
  const member = parts.slice(at0 + 1).join('.') || undefined;
  out.add(parts[at0], first >= 0 && !member ? 'new' : 'call', at, member, parts.slice(0, at0).join('.'));
}

const spec: LangSpec = {
  decl(n): Decl | null {
    switch (n.type) {
      case 'package_header':
      case 'import_list':
      case 'import_header':
        return { as: 'skip' };
      case 'class_declaration':
      case 'object_declaration': {
        const name = nameOf(n, 'type_identifier');
        if (!name) return null;
        const kw = keywords(n);
        const body = childOf(n, 'class_body', 'enum_class_body');
        const bases = n.namedChildren
          .filter((c) => c.type === 'delegation_specifier')
          .map((d) => d.descendantsOfType('type_identifier')[0]?.text)
          .filter((b): b is string => !!b);
        return {
          as: 'type',
          kind: kw.includes('interface') ? 'interface' : body?.type === 'enum_class_body' ? 'enum' : 'class',
          name,
          body,
          exported: !isPrivate(n),
          bases,
          decorators: annotations(n).map((a) => a.name),
        };
      }
      case 'companion_object':
        return { as: 'scope', body: childOf(n, 'class_body') };
      case 'function_declaration': {
        const name = nameOf(n, 'simple_identifier');
        if (!name) return null;
        const owner = enclosingClass(n);
        const own = annotations(n);
        const routes = annotationRoutes(own, owner ? annotations(owner) : [], n);
        return { as: 'function', kind: 'function', name, exported: !isPrivate(n), decorators: own.map((a) => a.name), routes };
      }
      case 'property_declaration': {
        // Top-level only: a class's properties are part of the class.
        if (n.parent?.type !== 'source_file') return null;
        const name = childOf(n, 'variable_declaration')?.namedChildren[0]?.text;
        return name ? { as: 'variable', kind: 'variable', name, exported: !isPrivate(n) } : null;
      }
      case 'type_alias': {
        const name = nameOf(n, 'type_identifier');
        return name ? { as: 'type', kind: 'type', name, exported: !isPrivate(n) } : null;
      }
    }
    return null;
  },
  ref(n, out) {
    switch (n.type) {
      case 'call_expression': {
        const callee = n.namedChildren[0];
        if (callee?.type === 'simple_identifier') {
          out.seen(callee);
          out.add(callee.text, capitalized(callee.text) ? 'new' : 'call', n);
        } else if (callee?.type === 'navigation_expression') {
          const [target, suffix] = callee.namedChildren;
          const member = suffix?.namedChildren[0];
          if (!member || member.type !== 'simple_identifier') return;
          out.seen(callee);
          out.seen(member);
          if (target?.type === 'this_expression') out.self(member.text, 'call', n);
          else if (target?.type === 'simple_identifier' && !capitalized(target.text) && capitalized(member.text)) addQualified(out, callee, n);
          else if (target?.type === 'simple_identifier') {
            out.seen(target);
            out.add(target.text, 'call', n, member.text);
          } else if (target?.type === 'navigation_expression') addQualified(out, callee, n);
        }
        return;
      }
      case 'navigation_expression': {
        const [target, suffix] = n.namedChildren;
        const member = suffix?.namedChildren[0];
        if (!member || member.type !== 'simple_identifier') return;
        out.seen(member);
        if (target?.type === 'this_expression') out.self(member.text, 'ref', n);
        else if (target?.type === 'simple_identifier' && capitalized(target.text)) {
          out.seen(target);
          out.add(target.text, 'ref', n, member.text);
        }
        return;
      }
      case 'type_identifier':
        out.add(n.text, 'type', n);
        return;
      case 'simple_identifier':
        if (capitalized(n.text)) out.add(n.text, 'ref', n);
        return;
    }
  },
};

export function extractKotlin(root: SyntaxNode, file: ParsedFile) {
  const pkg = childOf(root, 'package_header');
  const name = childOf(pkg, 'identifier')?.text;
  if (name) file.namespaces = [name];
  for (const h of root.descendantsOfType('import_header')) {
    const path = childOf(h, 'identifier')?.text;
    if (!path) continue;
    const last = path.slice(path.lastIndexOf('.') + 1);
    if (childOf(h, 'wildcard_import')) file.imports.push({ source: path, level: 0, names: [], open: true, line: line(h) });
    else {
      const alias = childOf(h, 'import_alias')?.namedChildren[0]?.text;
      file.imports.push({ source: path, level: 0, names: [{ imported: last, local: alias ?? last }], line: line(h) });
    }
  }
  outline(root, spec, file);
}
