// C and C++ fact extraction: `#include`s, functions, structs, classes, enums
// and typedefs, class methods as "Class.method" (including `Class::method`
// definitions outside the class), and prototypes in headers, which are what
// other files see through an include.

import type { ParsedFile } from '../model.ts';
import { innermost, outline, type Decl, type LangSpec, type RefSink } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const HEADER = /\.(h|hh|hpp|hxx|h\+\+|inl)$/;
const TYPE_SPEC = { struct_specifier: 'class', union_specifier: 'class', class_specifier: 'class', enum_specifier: 'enum' } as const;

/** Walk down pointer, reference and init declarators to the function declarator, if there is one. */
function functionDeclarator(n: SyntaxNode | null | undefined): SyntaxNode | null {
  for (let d = n; d; d = d.childForFieldName('declarator')) if (d.type === 'function_declarator') return d;

  return null;
}

/**
 * "helper", or for `Service::get` the name and the class it belongs to. A
 * scope that is a namespace this file opens (`acme::run`) isn't an owner.
 */
function functionName(fd: SyntaxNode, namespaces: Set<string>): { name: string; owner?: string } | null {
  let d = fd.childForFieldName('declarator');
  let owner: string | undefined;

  while (d?.type === 'qualified_identifier') {
    const scope = d.childForFieldName('scope');
    const s = scope?.type === 'template_type' ? scope.childForFieldName('name')?.text : scope?.text;
    owner = s && !namespaces.has(s) ? s : owner;
    d = d.childForFieldName('name');
  }

  if (!d || !/^(~?\w+|operator\W.*)$/.test(d.text)) return null;

  return owner ? { name: d.text, owner } : { name: d.text };
}

/**
 * `b::Foo` → the name and the namespace it gives ("b"; "" for `::Foo`), so
 * two namespaces' Foo stay apart. A class scope (`Service::create`) is kept
 * as the name's owner instead, by the callers.
 */
function qualified(n: SyntaxNode): { name: SyntaxNode; scope: string } | null {
  const parts: string[] = [];
  let d: SyntaxNode | null = n;

  while (d?.type === 'qualified_identifier') {
    const scope = d.childForFieldName('scope');
    parts.push(scope ? (scope.type === 'template_type' ? (scope.childForFieldName('name')?.text ?? scope.text) : scope.text) : '');
    d = d.childForFieldName('name');
  }

  if (d?.type === 'template_function' || d?.type === 'template_type') d = d.childForFieldName('name');

  return d ? { name: d, scope: parts.join('::') } : null;
}

/** A qualified name as a ref: `Service::create` names a class member; `util::convert` a namespace's function. */
function addQualified(out: RefSink, q: { name: SyntaxNode; scope: string }, kind: 'call' | 'new' | 'type' | 'ref', at: SyntaxNode) {
  out.seen(q.name);
  const last = q.scope.split('::').pop() ?? '';

  if (kind === 'call' && /^[A-Z]/.test(last)) out.add(last, 'call', at, q.name.text, q.scope.split('::').slice(0, -1).join('::') || undefined);
  else out.add(q.name.text, kind, at, undefined, q.scope);
}

const isStatic = (n: SyntaxNode) => n.namedChildren.some((c) => c.type === 'storage_class_specifier' && c.text === 'static');

function makeSpec(header: boolean, namespaces: Set<string>): LangSpec {
  return {
    decl(n): Decl | null {
      switch (n.type) {
        case 'preproc_include':
          return { as: 'skip' };
        case 'preproc_ifdef':
        case 'preproc_if':
        case 'preproc_else':
        case 'preproc_elif':
        case 'template_declaration':
          return { as: 'scope' };
        case 'linkage_specification':
        case 'namespace_definition':
          return { as: 'scope', body: n.childForFieldName('body') };
        case 'function_definition': {
          const fd = functionDeclarator(n.childForFieldName('declarator'));
          const name = fd && functionName(fd, namespaces);

          if (!name) return null;

          return { as: 'function', kind: 'function', name: name.name, owner: name.owner, exported: !isStatic(n) };
        }

        case 'declaration':
        case 'field_declaration': {
          // Prototypes: in a header they're the declaration other files include.
          if (!header) return null;
          const fd = functionDeclarator(n.childForFieldName('declarator'));
          const name = fd && functionName(fd, namespaces);

          if (!name) return null;

          return { as: 'function', kind: 'function', name: name.name, owner: name.owner, exported: !isStatic(n) };
        }

        case 'type_definition': {
          const name = n.childForFieldName('declarator')?.text;
          const type = n.childForFieldName('type');

          if (!name || !/^\w+$/.test(name)) return null;
          const body = type?.childForFieldName('body');
          const kind = type && type.type in TYPE_SPEC && body ? TYPE_SPEC[type.type as keyof typeof TYPE_SPEC] : 'type';

          return { as: 'type', kind, name, body };
        }

        case 'alias_declaration': {
          const name = n.childForFieldName('name')?.text;

          return name ? { as: 'type', kind: 'type', name } : null;
        }

        case 'struct_specifier':
        case 'union_specifier':
        case 'class_specifier':
        case 'enum_specifier': {
          const name = n.childForFieldName('name')?.text;
          const body = n.childForFieldName('body');

          if (!name || !body) return null;

          const bases = n.namedChildren
            .filter((c) => c.type === 'base_class_clause')
            .flatMap((c) => c.namedChildren.filter((b) => b.type === 'type_identifier' || b.type === 'qualified_identifier' || b.type === 'template_type'))
            .map((b) => (b.type === 'template_type' ? (b.childForFieldName('name')?.text ?? b.text) : b.text.split('::').pop()!));

          return { as: 'type', kind: TYPE_SPEC[n.type as keyof typeof TYPE_SPEC], name, body, bases };
        }
      }

      return null;
    },
    ref(n, out) {
      switch (n.type) {
        case 'call_expression': {
          let fn = n.childForFieldName('function');

          if (fn?.type === 'template_function') fn = fn.childForFieldName('name');

          if (!fn) return;

          if (fn.type === 'identifier') {
            out.seen(fn);
            out.add(fn.text, 'call', n);
          } else if (fn.type === 'field_expression') {
            const arg = fn.childForFieldName('argument');
            const field = fn.childForFieldName('field');
            out.seen(field);

            if (arg?.type === 'this' && field) out.self(field.text, 'call', n);
          } else if (fn.type === 'qualified_identifier') {
            const q = qualified(fn);

            if (!q || q.name.type !== 'identifier') return;
            out.seen(fn);
            out.seen(q.name);
            addQualified(out, q, 'call', n);
          }

          return;
        }

        case 'new_expression': {
          const type = n.childForFieldName('type');
          const q = type?.type === 'qualified_identifier' ? qualified(type) : null;
          const name = type?.type === 'template_type' ? type.childForFieldName('name')?.text : type?.text;
          out.seen(type);

          if (q) addQualified(out, q, 'new', n);
          else if (name) out.add(name, 'new', n);

          return;
        }

        case 'qualified_identifier': {
          const q = qualified(n);

          if (q && (q.name.type === 'type_identifier' || q.name.type === 'identifier')) addQualified(out, q, q.name.type === 'type_identifier' ? 'type' : 'ref', n);

          return true;
        }

        case 'field_expression': {
          const field = n.childForFieldName('field');
          out.seen(field);

          if (n.childForFieldName('argument')?.type === 'this' && field) out.self(field.text, 'ref', n);

          return;
        }

        case 'type_identifier':
          out.add(n.text, 'type', n);

          return;
        case 'identifier':
          out.add(n.text, 'ref', n);

          return;
      }
    },
  };
}

function includes(root: SyntaxNode, file: ParsedFile) {
  for (const inc of root.descendantsOfType('preproc_include')) {
    const p = inc.childForFieldName('path');

    if (!p) continue;
    const system = p.type === 'system_lib_string';
    const source = system ? p.text.slice(1, -1) : p.text.replace(/^"|"$/g, '');
    // An include makes everything the header declares visible here, and whatever it includes in turn.
    file.imports.push(system ? { source, level: 0, names: [], open: true, system, line: line(inc) } : { source, level: 0, names: [], open: true, line: line(inc) });
  }
}

export function extractC(root: SyntaxNode, file: ParsedFile) {
  includes(root, file);
  const defs = root.descendantsOfType('namespace_definition');
  const namespaces = new Set(defs.map((n) => n.childForFieldName('name')?.text ?? ''));
  outline(root, makeSpec(HEADER.test(file.path), namespaces), file);

  // Each declaration's namespace, nested ones joined ("a::b"); anonymous namespaces add nothing.
  const spans = defs.map((n) => {
    const names: string[] = [];

    for (let p: SyntaxNode | null = n; p; p = p.parent) if (p.type === 'namespace_definition') names.unshift(p.childForFieldName('name')?.text ?? '');

    return { name: names.filter(Boolean).join('::'), start: line(n), end: n.endPosition.row + 1 };
  });

  for (const s of file.symbols) {
    const ns = innermost(spans, s.lines[0], s.lines[1])?.name;

    if (ns) s.namespace = ns;
  }
}

/** Headers are shared by C and C++; one with C++-only syntax is C++. */
export const looksLikeCpp = (text: string) => /^\s*(class|namespace|template\s*<|using\s+namespace|public:|private:|protected:)\b|\w::\w/m.test(text);
