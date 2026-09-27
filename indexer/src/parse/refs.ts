// Accumulates the identifiers a symbol uses, keeping one entry per name with
// the strongest kind seen (a call beats a type reference beats a bare use).

import type { Ref, RefKind } from '../model.ts';

const RANK: Record<RefKind, number> = { call: 5, new: 4, jsx: 3, type: 2, ref: 1 };

export class RefSet {
  private map = new Map<string, Ref>();
  constructor(private readonly self?: string) {}

  add(name: string, kind: RefKind, member?: string) {
    if (!name || name === this.self) return;
    const key = member ? `${name}.${member}` : name;
    const prev = this.map.get(key);
    if (!prev || RANK[kind] > RANK[prev.kind]) this.map.set(key, member ? { name, member, kind } : { name, kind });
  }

  list(): Ref[] {
    return [...this.map.values()];
  }
}
