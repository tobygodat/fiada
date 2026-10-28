// Swift fact extraction: imports, classes, structs, enums, actors, protocols
// and their methods, extensions' methods under the type they extend, and
// top-level functions and constants. A Swift module needs no imports between
// its own files, so links are resolved by name within the module.

import type { ParsedFile } from '../model.ts';
import { capitalized, childOf, keywords, outline, type Decl, type LangSpec } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const isPrivate = (n: SyntaxNode) => !!childOf(n, 'modifiers')?.descendantsOfType('visibility_modifier').some((v) => /^(private|fileprivate)/.test(v.text));

const spec: LangSpec = {
  decl(n): Decl | null {
    switch (n.type) {
      case 'import_declaration':
        return { as: 'skip' };
      case 'class_declaration': {
        const kw = keywords(n);
        const nameNode = n.childForFieldName('name');

        if (kw.includes('extension')) {
          const extended = nameNode?.descendantsOfType('type_identifier').pop()?.text;

          return { as: 'scope', body: n.childForFieldName('body'), owner: extended };
        }

        if (!nameNode) return null;

        const bases = n.namedChildren
          .filter((c) => c.type === 'inheritance_specifier')
          .map((c) => c.descendantsOfType('type_identifier')[0]?.text)
          .filter((b): b is string => !!b);

        return {
          as: 'type',
          kind: kw.includes('enum') ? 'enum' : 'class',
          name: nameNode.text,
          body: n.childForFieldName('body'),
          exported: !isPrivate(n),
          bases,
        };
      }

      case 'protocol_declaration': {
        const name = n.childForFieldName('name')?.text;

        return name ? { as: 'type', kind: 'interface', name, body: n.childForFieldName('body'), exported: !isPrivate(n) } : null;
      }

      case 'function_declaration':
      case 'protocol_function_declaration': {
        const name = n.childForFieldName('name')?.text;

        return name ? { as: 'function', kind: 'function', name, exported: !isPrivate(n) } : null;
      }

      case 'typealias_declaration': {
        const name = n.childForFieldName('name')?.text;

        return name ? { as: 'type', kind: 'type', name, exported: !isPrivate(n) } : null;
      }

      case 'property_declaration': {
        if (n.parent?.type !== 'source_file') return null;
        const name = n.childForFieldName('name')?.descendantsOfType('simple_identifier')[0]?.text;

        return name ? { as: 'variable', kind: 'variable', name, exported: !isPrivate(n) } : null;
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
          const target = callee.childForFieldName('target');
          const member = callee.childForFieldName('suffix')?.childForFieldName('suffix');

          if (!member) return;
          out.seen(callee);
          out.seen(member);

          if (target?.type === 'self_expression') out.self(member.text, 'call', n);
          else if (target?.type === 'simple_identifier') {
            out.seen(target);
            out.add(target.text, 'call', n, member.text);
          }
        }

        return;
      }

      case 'navigation_expression': {
        const target = n.childForFieldName('target');
        const member = n.childForFieldName('suffix')?.childForFieldName('suffix');

        if (!member) return;
        out.seen(member);

        if (target?.type === 'self_expression') out.self(member.text, 'ref', n);
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

export function extractSwift(root: SyntaxNode, file: ParsedFile) {
  for (const imp of root.namedChildren.filter((c) => c.type === 'import_declaration')) {
    const name = childOf(imp, 'identifier')?.text;

    // `import Models`: another module, whose names are all visible here.
    if (name) file.imports.push({ source: name, level: 0, names: [], open: true, line: line(imp) });
  }

  outline(root, spec, file);
}
