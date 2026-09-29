// Facts the parsers extract from one file. Everything downstream (linking,
// classification, graph assembly) works from these, never from raw syntax.

import type { RepoInfo, SymbolKind } from '@fiada/shared';

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'java' | 'kotlin' | 'csharp' | 'rust' | 'c' | 'cpp' | 'ruby' | 'swift';

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
  /**
   * Every name of the module is visible here without a prefix: Java's
   * `import a.b.*`, C#'s `using A.B;`, Rust's `use a::*`, a C `#include`.
   */
  open?: boolean;
  line: number;
}

export type RefKind = 'call' | 'new' | 'jsx' | 'type' | 'ref';

/** An identifier a symbol uses. `member` is set for `obj.member` forms. */
export interface Ref {
  name: string;
  member?: string;
  kind: RefKind;
  /** Line of the use that decided `kind` (the first call, else the first JSX use, …). */
  line: number;
}

export interface RouteDecl {
  method: string; // upper-case HTTP verb, or "*" for any
  path: string; // including any router prefix we could see in the same file
  line: number;
  /**
   * The router object the route is declared on, as a name in the declaring
   * scope ("router", "app", "v1"), or "#<n>" for the enclosing function's
   * n-th parameter (Go's `func Register(r *gin.RouterGroup)`). Unset when the
   * route has no router object (Next.js files, decorators on unknown objects).
   */
  router?: string;
  /** Handler named in the declaration (`router.get("/x", getItems)`); the route is attributed to it. */
  handler?: string;
  /** Line of the router's own prefix (`APIRouter(prefix="/items")`), when the path includes one. */
  prefixLine?: number;
}

/** A piece of a URL or prefix: literal text, or an expression we may resolve to a constant. */
export type UrlPart = { lit: string } | { expr: string };

export interface HttpRequest {
  method: string;
  /** Path with interpolations as "{}", and any leading base-URL variable stripped. */
  path: string;
  line: number;
  /** Expression that was stripped from the front, e.g. "API_URL" in `${API_URL}/items`. */
  base?: string;
  /** The client object it went through, e.g. "client" in `client.post("/documents.list")`. */
  via?: string;
}

/**
 * A module-level HTTP client whose requests get a base URL: `axios.create({ baseURL: "/api" })`,
 * or `new ApiClient()` where the class sets `this.baseUrl = … "/api"`.
 */
export interface ClientDecl {
  name: string;
  /** Class it instantiates, whose `clientBase` applies. */
  ctor?: string;
  base?: UrlPart[];
  line: number;
}

/**
 * A router created in this scope: an application root (`FastAPI()`,
 * `express()`, `gin.Default()`) whose routes have no prefix above them, or a
 * sub-router (`APIRouter()`, `express.Router()`).
 */
export interface RouterDecl {
  name: string;
  root: boolean;
  line: number;
}

/**
 * One router mounted under another: `app.include_router(items.router,
 * prefix="/items")`, `app.use("/api", api)`, `v1 := r.Group("/api")`, or
 * `articles.Register(v1.Group("/articles"))` where the child is a function's
 * router parameter.
 */
export interface MountDecl {
  /** Parent router name in this scope. */
  parent: string;
  /** Child router as written ("items.router", "api"), or a function parameter it's passed as. */
  child: string | { fn: string; arg: number };
  prefix: UrlPart[];
  line: number;
}

/** A string constant, for resolving URL prefixes like `settings.API_V1_STR`. */
export interface ConstDecl {
  name: string;
  value: string;
  line: number;
  /** Class the constant is declared in (Python class attributes). */
  owner?: string;
}

/** A client-side page route (React Router `<Route>`, TanStack `createFileRoute`). */
export interface PageDecl {
  path: string;
  /** Component rendered for the path; unset when the page is the declaring file itself. */
  component?: string;
  line: number;
}

/** ORM link from an entity to another: SQLAlchemy relationship() / ForeignKey, SQLModel foreign_key, GORM fields. */
export interface OrmRef {
  kind: 'relationship' | 'foreign-key';
  /** Class name (relationship) or "table.column" (foreign key). */
  target: string;
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
  routers?: RouterDecl[];
  mounts?: MountDecl[];
  /** Body contains JSX. */
  jsx?: boolean;
  /** Parameter names, for routers passed in as arguments. */
  params?: string[];
  /** ORM table name (`__tablename__`, GORM TableName) when the class declares one. */
  tableName?: string;
  /** An HTTP client class's base URL: `baseUrl = "/api"` or `this.baseUrl = options.baseUrl || "/api"`. */
  clientBase?: { parts: UrlPart[]; line: number };
  /** The class body declares mapped columns (Column, mapped_column, Mapped[…], gorm tags). */
  columns?: boolean;
  orm?: OrmRef[];
  /** Go: the receiver type of a method (`func (m *ArticleModel) Update()` → "ArticleModel"). */
  receiver?: string;
  /** C#: the namespace declaring it, nested ones joined ("A.B"), when a file may hold several. */
  namespace?: string;
}

export interface ParsedFile {
  path: string; // repo-relative, forward slashes
  lang: Lang;
  loc: number;
  imports: ImportSpec[];
  symbols: ParsedSymbol[];
  /** Refs made from module-level code outside any symbol. */
  fileRefs: Ref[];
  /** Routes, requests, routers and mounts declared outside any symbol. */
  routes: RouteDecl[];
  requests: HttpRequest[];
  routers: RouterDecl[];
  mounts: MountDecl[];
  constants: ConstDecl[];
  pages: PageDecl[];
  /** HTTP client instances with a base URL (TypeScript/JavaScript). */
  clients?: ClientDecl[];
  /** Go: package clause name. */
  goPackage?: string;
  /** Java and Kotlin package, or C# namespaces, that this file's declarations belong to. */
  namespaces?: string[];
  /** Source text of the lines evidence points at, keyed by line number. */
  code: Record<number, string>;
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
  /** Go module paths from go.mod files, by the directory they're in ("" for the root). */
  goModules?: { dir: string; module: string }[];
  /** Rust crates from Cargo.toml files: their directory ("" for the root) and name as code writes it (dashes become underscores). */
  rustCrates?: { dir: string; name: string }[];
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
