// Ruby fact extraction: `require`s, classes and modules (nested ones as
// "Admin::Users"), their methods as "Admin::Users.index", and the constants
// and methods each one uses. Rails autoloads constants, so most links are
// resolved by name across the repository rather than through a require.

import type { ParsedFile } from '../model.ts';
import { literal, outline, SELF, type Decl, type LangSpec } from './outline.ts';
import { line, type SyntaxNode } from './treesitter.ts';

const REQUIRE = new Set(['require', 'require_relative', 'load', 'autoload']);

const spec: LangSpec = {
  join: (owner, name, as) => (as === 'type' ? `${owner}::${name}` : `${owner}.${name}`),
  decl(n): Decl | null {
    switch (n.type) {
      case 'class':
      case 'module': {
        const name = n.childForFieldName('name')?.text;
        if (!name) return null;
        const sup = n.childForFieldName('superclass')?.namedChildren[0]?.text;
        return { as: 'type', kind: 'class', name, body: n.childForFieldName('body'), bases: sup ? [sup] : undefined };
      }
      case 'method':
      case 'singleton_method': {
        const name = n.childForFieldName('name')?.text;
        return name ? { as: 'function', kind: 'function', name } : null;
      }
      case 'singleton_class':
        return { as: 'scope', body: n.childForFieldName('body') };
      case 'call':
        return REQUIRE.has(n.childForFieldName('method')?.text ?? '') && !n.childForFieldName('receiver') ? { as: 'skip' } : null;
    }
    return null;
  },
  ref(n, out) {
    switch (n.type) {
      case 'call': {
        const receiver = n.childForFieldName('receiver');
        const method = n.childForFieldName('method');
        if (!method) return;
        out.seen(method);
        const kind = method.text === 'new' ? 'new' : 'call';
        if (!receiver) out.add(method.text, 'call', n);
        else if (receiver.type === 'self') out.self(method.text, 'call', n);
        else if (receiver.type === 'constant' || receiver.type === 'scope_resolution') {
          out.seen(receiver);
          for (const c of receiver.descendantsOfType('constant')) out.seen(c);
          out.add(receiver.text.replace(/^::/, ''), kind, n, method.text === 'new' ? undefined : method.text);
        }
        return;
      }
      case 'scope_resolution':
        out.add(n.text.replace(/^::/, ''), 'ref', n);
        return true;
      case 'superclass': {
        const c = n.namedChildren[0];
        if (c) out.add(c.text.replace(/^::/, ''), 'type', n);
        return true;
      }
      case 'constant':
        out.add(n.text, 'ref', n);
        return;
      case 'identifier':
        // A bare word may be a method call without parentheses; only a sibling method is kept.
        if (n.parent?.type === 'body_statement' || n.parent?.type === 'argument_list') out.add(n.text, 'call', n);
        return;
    }
  },
};

export function extractRuby(root: SyntaxNode, file: ParsedFile) {
  for (const call of root.descendantsOfType('call')) {
    const method = call.childForFieldName('method')?.text ?? '';
    if (!REQUIRE.has(method) || call.childForFieldName('receiver')) continue;
    const strings = call.childForFieldName('arguments')?.namedChildren.filter((a) => a.type === 'string') ?? [];
    const source = literal(strings[strings.length - 1]);
    // require_relative is relative to this file; the others search the load path.
    if (source) file.imports.push({ source: method === 'require_relative' ? `./${source.replace(/^\.\//, '')}` : source, level: 0, names: [], line: line(call) });
  }
  outline(root, spec, file);
  // Bare words that aren't sibling methods are local variables or Ruby's own methods.
  const names = new Set(file.symbols.map((s) => s.name));
  for (const s of file.symbols) s.refs = s.refs.filter((r) => r.kind !== 'call' || r.member || /^[A-Z]/.test(r.name) || names.has(r.name) || r.name === SELF);
}
