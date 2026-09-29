// Accumulates the identifiers a symbol uses, keeping one entry per name with
// the strongest kind seen (a call beats a type reference beats a bare use),
// and the line of the first use of that kind as evidence.

import type { Ref, RefKind } from '../model.ts';

const RANK: Record<RefKind, number> = { call: 5, new: 4, jsx: 3, type: 2, ref: 1 };

export class RefSet {
  private map = new Map<string, Ref>();
  constructor(private readonly self?: string) {}

  add(name: string, kind: RefKind, line: number, member?: string, scope?: string) {
    if (!name || name === this.self) return;
    const key = `${scope != null ? `${scope}::` : ''}${member ? `${name}.${member}` : name}`;
    const prev = this.map.get(key);
    if (!prev || RANK[kind] > RANK[prev.kind] || (RANK[kind] === RANK[prev.kind] && line < prev.line)) {
      const ref: Ref = member ? { name, member, kind, line } : { name, kind, line };
      if (scope != null) ref.scope = scope;
      this.map.set(key, ref);
    }
  }

  merge(refs: Ref[]) {
    for (const r of refs) this.add(r.name, r.kind, r.line, r.member, r.scope);
  }

  list(): Ref[] {
    return [...this.map.values()];
  }
}
