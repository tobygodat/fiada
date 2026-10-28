// Which classes and structs are ORM entities, and the table names they map to.
// Shared by the fact detectors (a `table` fact) and the linker (foreign keys
// and relationships between entities).

import type { ParsedFile, ParsedSymbol } from './model.ts';

/** SQLAlchemy / Django / Flask-SQLAlchemy / Mongo / TypeORM / GORM base classes, and SQLModel's `table=True`. */
export const ORM_BASES = /(^|\.)(Base|DeclarativeBase|Model|Document|Entity|BaseEntity)$|^table=True$/;

/** Declarative bases themselves (`class Base(DeclarativeBase): pass`) aren't tables. */
const DECLARATIVE_ROOT = /(^|\.)(DeclarativeBase|DeclarativeBaseNoMeta|AsyncAttrs)$/;

export function isTable(s: ParsedSymbol): boolean {
  if (s.kind !== 'class') return false;

  if (s.tableName || s.columns) return true;
  const bases = s.bases ?? [];

  if (bases.some((b) => DECLARATIVE_ROOT.test(b))) return false;

  return bases.some((b) => ORM_BASES.test(b));
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const plural = (s: string) => (/(s|x|z|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);

/**
 * Table names an entity is known by: its declared name first, then the
 * defaults frameworks derive (SQLModel lower-cases the class name, GORM
 * snake-cases and pluralises it). Only the first one is certain.
 */
export function tableNames(file: ParsedFile, s: ParsedSymbol): string[] {
  const out: string[] = [];

  if (s.tableName) out.push(s.tableName);
  const lower = s.name.toLowerCase();
  out.push(file.lang === 'go' ? plural(snake(s.name)) : lower, snake(s.name), plural(snake(s.name)), plural(lower));

  return [...new Set(out)];
}
