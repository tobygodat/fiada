// Facts the parsers extract from one file. Everything downstream (linking,
// classification, graph assembly) works from these, never from raw syntax.

import type { RepoInfo, SymbolKind } from '@strata/shared';

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python';

export interface ImportBinding {
  /** Name in the source module: an identifier, "default", or "*" for the whole module. */
  imported: string;
  /** Name bound in this file. */
  local: string;
}

export interface ImportSpec {
  /** Module specifier as written: "./api", "react", "app.models". */
  source: string;
  /** Python relative-import depth (the number of leading dots). 0 for absolute. */
  level: number;
  names: ImportBinding[];
  /** `export … from` in TS/JS: the names become part of this file's exports. */
  reexport?: boolean;
  /** `export * from` in TS/JS. */
  reexportAll?: boolean;
  line: number;
}

export type RefKind = 'call' | 'new' | 'jsx' | 'type' | 'ref';

/** An identifier a symbol uses. `member` is set for `obj.member` forms. */
export interface Ref {
  name: string;
  member?: string;
  kind: RefKind;
}

export interface RouteDecl {
  method: string; // upper-case HTTP verb, or "*" for any
  path: string; // including any router prefix we could see in the same file
  line: number;
}

export interface HttpRequest {
  method: string;
  path: string;
  line: number;
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  isDefault?: boolean;
  lines: [number, number];
  refs: Ref[];
  /** Base classes (Python, TS `extends`). */
  bases?: string[];
  /** Decorator names, e.g. "router.get", "dataclass". */
  decorators?: string[];
  routes?: RouteDecl[];
  requests?: HttpRequest[];
  /** Body contains JSX. */
  jsx?: boolean;
}

export interface ParsedFile {
  path: string; // repo-relative, forward slashes
  lang: Lang;
  loc: number;
  imports: ImportSpec[];
  symbols: ParsedSymbol[];
  /** Refs made from module-level code outside any symbol. */
  fileRefs: Ref[];
  /** Routes and requests declared outside any symbol. */
  routes: RouteDecl[];
  requests: HttpRequest[];
  /** TS/JS: names listed in `export { a, b }` without a source. */
  localExports: string[];
  /** TS/JS: local name of the default export when it is an identifier. */
  defaultExport?: string;
  /** Contains JSX anywhere. */
  jsx: boolean;
  /** Parse errors were present; facts may be partial. */
  partial?: boolean;
}

export interface PackageManifest {
  /** Repo-relative directory of the package.json ("" for the root). */
  dir: string;
  name?: string;
  main?: string;
  deps: string[];
}

export interface TsConfigPaths {
  dir: string;
  baseUrl?: string;
  paths: Record<string, string[]>;
}

export interface ParsedRepo {
  info: RepoInfo;
  /** Absolute path on disk. */
  root: string;
  files: ParsedFile[];
  packages: PackageManifest[];
  /** Python dependency names from pyproject.toml / requirements*.txt. */
  pyDeps: string[];
  tsconfigs: TsConfigPaths[];
  /** Directories that act as Python import roots ("" = repo root). */
  pyRoots: string[];
  frameworks: string[];
}
