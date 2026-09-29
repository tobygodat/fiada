// C and C++ fact extraction: `#include`s, functions, structs, classes, enums
// and typedefs, class methods as "Class.method" (including `Class::method`
// definitions outside the class), and prototypes in headers, which are what
// other files see through an include.

import type { ParsedFile } from '../model.ts';
import { outline, type Decl, type LangSpec } from './outline.ts';
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
            const scope = fn.childForFieldName('scope');
            let name = fn.childForFieldName('name');
            if (name?.type === 'template_function') name = name.childForFieldName('name');
            if (!name || name.type !== 'identifier') return;
            out.seen(fn);
            out.seen(name);
            // `Service::create()` names a class; `util::convert()` a namespace, which isn't tracked, so just the function.
            const s = scope?.text.split('::').pop() ?? '';
            if (/^[A-Z]/.test(s)) out.add(s, 'call', n, name.text);
            else out.add(name.text, 'call', n);
          }
          return;
        }
        case 'new_expression': {
          const type = n.childForFieldName('type');
          const name = type?.type === 'template_type' ? type.childForFieldName('name')?.text : type?.text.split('::').pop();
          out.seen(type);
          if (name) out.add(name, 'new', n);
          return;
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
  const namespaces = new Set(root.descendantsOfType('namespace_definition').map((n) => n.childForFieldName('name')?.text ?? ''));
  outline(root, makeSpec(HEADER.test(file.path), namespaces), file);
}

/** Headers are shared by C and C++; one with C++-only syntax is C++. */
export const looksLikeCpp = (text: string) => /^\s*(class|namespace|template\s*<|using\s+namespace|public:|private:|protected:)\b|\w::\w/m.test(text);
