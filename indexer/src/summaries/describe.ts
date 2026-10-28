// The line every node gets straight away, built from what the indexer already
// knows: kind, routes, what it defines, what it calls and who uses it. It is
// the summary until a generated one exists, and the whole summary when no
// model key is set, so it has to read as a sentence, not a list of fields.

import { UNLAYERED, UNSORTED_DOMAIN, type Graph, type GraphEdge, type GraphNode } from '@fiada/shared';

/** Lookups over one graph, built once per graph version. */
export interface GraphIndex {
  graph: Graph;
  byId: Map<string, GraphNode>;
  children: Map<string, GraphNode[]>;
  /** Edges by their `from` and `to` ids (files and symbols). */
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  layerName(id: string | undefined): string;
  domainName(id: string): string;
}

export function indexGraph(graph: Graph): GraphIndex {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, GraphNode[]>();

  for (const n of graph.nodes) {
    const list = children.get(n.parent);

    if (list) list.push(n);
    else children.set(n.parent, [n]);
  }

  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();

  const push = (m: Map<string, GraphEdge[]>, k: string, e: GraphEdge) => {
    const list = m.get(k);

    if (list) list.push(e);
    else m.set(k, [e]);
  };

  for (const e of graph.edges) {
    push(out, e.from, e);
    push(inn, e.to, e);
  }

  const layers = new Map(graph.layers.map((l) => [l.id, l.name]));
  const domains = new Map(graph.domains.map((d) => [d.id, d.name]));

  return {
    graph,
    byId,
    children,
    out,
    in: inn,
    // In a sentence: "API", "UI" stay capitals, "Data" reads as "data".
    layerName: (id) => {
      const name = !id || id === UNLAYERED ? 'unlayered' : (layers.get(id) ?? id);

      return /^[A-Z0-9]+$/.test(name) ? name : name.toLowerCase();
    },
    domainName: (id) => domains.get(id) ?? (id === UNSORTED_DOMAIN ? 'Unsorted' : id),
  };
}

/** The web app's function view names its groups `domain:<id>` and `domain:<id>/<layer>`. */
export function parseGroupId(gi: GraphIndex, id: string): { domain: string; layer?: string } | null {
  if (!id.startsWith('domain:')) return null;
  const rest = id.slice('domain:'.length);

  if (gi.graph.domains.some((d) => d.id === rest) || rest === UNSORTED_DOMAIN) return { domain: rest };
  const cut = rest.lastIndexOf('/');

  if (cut < 0) return { domain: rest };

  return { domain: rest.slice(0, cut), layer: rest.slice(cut + 1) };
}

/** What sits in a function-view group: symbols, and files that have no symbols of their own. */
export function groupMembers(gi: GraphIndex, g: { domain: string; layer?: string }): GraphNode[] {
  return gi.graph.nodes.filter(
    (n) =>
      (n.kind === 'symbol' || (n.kind === 'file' && !gi.children.get(n.id)?.some((c) => c.kind === 'symbol'))) &&
      (n.domain?.id ?? UNSORTED_DOMAIN) === g.domain &&
      (g.layer == null || (n.layer?.id ?? UNLAYERED) === g.layer),
  );
}

// ── words ──

export const shortName = (id: string) => (id.includes('#') ? id.slice(id.indexOf('#') + 1) : id.slice(id.lastIndexOf('/') + 1));

/** "a", "a and b", "a, b and c", "a, b and 3 more". */
export function list(items: string[], max = 3, noun?: [string, string]): string {
  const xs = [...new Set(items)];

  if (xs.length <= max) return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? '');
  const more = xs.length - max;

  return `${xs.slice(0, max).join(', ')} and ${more} more${noun ? ` ${more === 1 ? noun[0] : noun[1]}` : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const LANG = new Map(Object.entries({ python: 'Python', typescript: 'TypeScript', tsx: 'TypeScript', javascript: 'JavaScript', go: 'Go' }));

const FRAMEWORK = new Map(Object.entries({
  react: 'React', next: 'Next.js', vue: 'Vue', svelte: 'Svelte', angular: 'Angular', 'react-native': 'React Native', express: 'Express',
  fastify: 'Fastify', hono: 'Hono', nestjs: 'NestJS', koa: 'Koa', prisma: 'Prisma', drizzle: 'Drizzle', typeorm: 'TypeORM', mongoose: 'Mongoose',
  fastapi: 'FastAPI', flask: 'Flask', django: 'Django', sqlalchemy: 'SQLAlchemy', sqlmodel: 'SQLModel', celery: 'Celery', airflow: 'Airflow',
  pandas: 'pandas', torch: 'PyTorch', pydantic: 'Pydantic', gin: 'Gin', echo: 'Echo', chi: 'chi', fiber: 'Fiber', 'gorilla-mux': 'gorilla/mux',
  gorm: 'GORM', ent: 'ent', sqlx: 'sqlx',
}));

const facts = (n: GraphNode, type: string) => (n.facts ?? []).filter((f) => f.type === type).map((f) => f.value);
const has = (n: GraphNode, type: string) => (n.facts ?? []).some((f) => f.type === type);

/** The file a file or symbol id belongs to. */
function fileOf(gi: GraphIndex, id: string): string {
  const n = gi.byId.get(id);

  return n?.kind === 'symbol' ? n.parent : id;
}

/** Other files whose code uses anything inside `inside` (and ones it uses), as file ids. */
export function fileNeighbours(gi: GraphIndex, members: GraphNode[], inside: (id: string) => boolean) {
  const usedBy = new Map<string, number>();
  const uses = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const n of members) {
    for (const e of gi.in.get(n.id) ?? []) if (!inside(e.from)) bump(usedBy, fileOf(gi, e.from));

    for (const e of gi.out.get(n.id) ?? []) if (!inside(e.to)) bump(uses, fileOf(gi, e.to));
  }

  const ranked = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  return { usedBy: ranked(usedBy), uses: ranked(uses) };
}

/** A symbol's callers and callees, by name, strongest kind first. */
export function symbolNeighbours(gi: GraphIndex, id: string) {
  const name = (other: string) => gi.byId.get(other)?.name ?? shortName(other);
  const outE = gi.out.get(id) ?? [];
  const inE = gi.in.get(id) ?? [];
  const pick = (es: GraphEdge[], end: 'from' | 'to', kinds: string[]) => [...new Set(es.flatMap((e) => (kinds.includes(e.kind) && e[end] !== id ? [name(e[end])] : [])))];

  return {
    calls: pick(outE, 'to', ['calls', 'http']),
    renders: pick(outE, 'to', ['renders']),
    types: pick(outE, 'to', ['type', 'references']),
    httpCallers: pick(inE, 'from', ['http']),
    users: pick(inE, 'from', ['calls', 'renders', 'references', 'type', 'imports']),
  };
}

// ── lines ──

const BARE = new Set(['UI component', 'Class', 'Enum', 'Type', 'Value', 'Function']);

export function describeSymbol(gi: GraphIndex, n: GraphNode): string {
  const nb = symbolNeighbours(gi, n.id);
  const routes = n.routes ?? facts(n, 'route');
  const requests = facts(n, 'request');
  const bases = facts(n, 'extends');
  const kind = n.symbolKind ?? 'function';
  // A bare noun ("Function") joins its usage into one sentence: "Function used by a and b."
  let role: string;

  if (routes.length) role = `Handles ${list(routes, 2, ['route', 'routes'])}`;
  else if (has(n, 'table')) role = `Database model${bases.length ? ` built on ${list(bases, 2)}` : ''}, mapped to its own table`;
  else if (kind === 'component' || has(n, 'returnsJSX')) role = nb.renders.length ? `UI component that renders ${list(nb.renders)}` : 'UI component';
  else if (requests.length) role = `Requests ${list(requests, 2)}`;
  else if (kind === 'class') role = bases.length ? `Class built on ${list(bases, 2)}` : 'Class';
  else role = kind === 'enum' ? 'Enum' : kind === 'interface' || kind === 'type' ? 'Type' : kind === 'variable' ? 'Value' : 'Function';
  let bare = BARE.has(role);

  if (!routes.length && kind !== 'component' && nb.calls.length) {
    role += `${bare ? ' that calls' : '; calls'} ${list(nb.calls)}`;
    bare = false;
  }

  const verb = kind === 'function' || kind === 'component' ? 'calls' : 'uses';

  if (nb.httpCallers.length) return `${role}. Called over HTTP by ${list(nb.httpCallers)}.`;

  if (nb.users.length) return bare ? `${role} used by ${list(nb.users)}.` : `${role}. Used by ${list(nb.users)}.`;

  if (routes.length || has(n, 'pageRoute')) return `${role}.`;

  return bare ? `${role} that nothing in the map ${verb}.` : `${role}. Nothing in the map ${verb} it.`;
}

export function describeFile(gi: GraphIndex, n: GraphNode): string {
  const symbols = (gi.children.get(n.id) ?? []).filter((c) => c.kind === 'symbol');
  const names = symbols.map((s) => s.name);
  const routes = n.routes?.length ? n.routes : facts(n, 'route');
  const pages = facts(n, 'pageRoute');
  const entry = facts(n, 'entrypoint')[0];
  const test = has(n, 'test');
  let role: string;

  if (test) role = names.length ? `Tests ${list(names, 3)}` : 'Tests';
  else if (pages.length) role = `The ${list(pages, 2)} page${names.length ? `, defining ${list(names, 2)}` : ''}`;
  else if (routes.length) role = `Serves ${list(routes, 2, ['route', 'routes'])}`;
  else if (entry) role = `The ${entry === 'main' ? 'main' : entry} entry point${names.length ? `, defining ${list(names, 2)}` : ''}`;
  else if (has(n, 'typeOnly')) role = `Declares the types ${list(names, 3)}`;
  else if (names.length) role = `Defines ${list(names, 3)}`;
  else role = `${plural(n.loc ?? 0, 'line')} of ${LANG.get(n.lang ?? '') ?? 'code'} with no functions or classes`;

  const inside = (id: string) => id === n.id || id.startsWith(`${n.id}#`);
  const { usedBy } = fileNeighbours(gi, [n, ...symbols], inside);
  let use = '';

  if (usedBy.length) use = `Used by ${list(usedBy.map(shortName), 3)}.`;
  else if (!test && !entry && !pages.length) use = 'Nothing else in the map imports it.';

  return `${role}.${use ? ` ${use}` : ''}`;
}

/** Everything under a folder or repository. */
export function descendants(gi: GraphIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];

  const walk = (p: string) => {
    for (const c of gi.children.get(p) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };

  walk(id);

  return out;
}

function mostly(gi: GraphIndex, files: GraphNode[]): string {
  const tally = new Map<string, number>();

  for (const f of files) if (f.layer && f.layer.id !== UNLAYERED) tally.set(f.layer.id, (tally.get(f.layer.id) ?? 0) + (f.loc ?? 1));
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const top = [...tally].sort((a, b) => b[1] - a[1])[0];

  if (!top || top[1] < total * 0.5) return '';

  return gi.layerName(top[0]);
}

export function describeFolder(gi: GraphIndex, n: GraphNode): string {
  const all = descendants(gi, n.id);
  const files = all.filter((d) => d.kind === 'file');
  const routes = new Set(all.flatMap((d) => d.routes ?? [])).size;
  const layer = mostly(gi, files);
  const top = [...files].sort((a, b) => (b.loc ?? 0) - (a.loc ?? 0)).map((f) => f.name);
  const inside = (id: string) => id.startsWith(`${n.id}/`);
  const { usedBy } = fileNeighbours(gi, all, inside);
  const what = `${plural(files.length, 'file')}${layer ? ` of mostly ${layer} code` : ''}`;
  const parts = [files.length <= 3 ? `${what}: ${list(top, 3)}.` : `${what}; the largest are ${list(top.slice(0, 3), 3)}.`];

  if (routes) parts.push(`Serves ${plural(routes, 'HTTP route')}.`);
  parts.push(usedBy.length ? `Used by ${plural(usedBy.length, 'file')} elsewhere.` : 'Nothing outside it uses it.');

  return parts.join(' ');
}

export function describeRepo(gi: GraphIndex, n: GraphNode): string {
  const info = gi.graph.repos.find((r) => r.id === n.id);

  const langs = Object.entries(info?.languages ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => LANG.get(l) ?? l);

  const fws = (info?.frameworks ?? []).map((f) => FRAMEWORK.get(f) ?? f);
  const all = descendants(gi, n.id);
  const routes = new Set(all.flatMap((d) => d.routes ?? []));
  const head = `${langs.length ? `A ${list(langs, 3)}` : 'A'} codebase${fws.length ? ` using ${list(fws, 5)}` : ''}`;
  const parts = [`${head}: ${plural(info?.fileCount ?? 0, 'file')} and ${plural(info?.symbolCount ?? 0, 'symbol')}.`];

  if (routes.size) parts.push(`Serves ${plural(routes.size, 'HTTP route')}.`);
  const other = new Set<string>();

  for (const d of all) for (const e of gi.out.get(d.id) ?? []) if (e.kind === 'http') other.add(gi.byId.get(e.to)?.repo ?? n.id);
  other.delete(n.id);

  if (other.size) parts.push(`Calls the API in ${list([...other].map((r) => gi.graph.repos.find((x) => x.id === r)?.name ?? r), 2)}.`);

  return parts.join(' ');
}

export function describeGroup(gi: GraphIndex, g: { domain: string; layer?: string }): string {
  const members = groupMembers(gi, g);
  const files = new Map<string, number>();

  for (const m of members) {
    const f = m.kind === 'symbol' ? m.parent : m.id;
    files.set(f, (files.get(f) ?? 0) + 1);
  }

  const topFiles = [...files].sort((a, b) => b[1] - a[1]).map(([f]) => shortName(f));
  const repos = [...new Set(members.map((m) => m.repo))].map((r) => gi.graph.repos.find((x) => x.id === r)?.name ?? r);
  const where = repos.length > 1 ? ` across ${list(repos, 3)}` : '';
  const domain = gi.domainName(g.domain);

  if (g.layer != null) {
    return `${plural(members.length, `${gi.layerName(g.layer)} symbol`)} in ${domain}${where}: ${list(members.map((m) => m.name), 3)}.`;
  }

  const layers = [...new Set(members.map((m) => m.layer?.id ?? UNLAYERED))].map((l) => gi.layerName(l));
  const across = layers.length === 1 ? `in the ${layers[0]} layer` : `across the ${list(layers, 6)} layers`;

  return `${plural(members.length, 'symbol')} ${across}${where}, mostly in ${list(topFiles, 3)}.`;
}

/** The line for any node the map can select, or null for an id it doesn't know. */
export function describe(gi: GraphIndex, id: string): string | null {
  const g = parseGroupId(gi, id);

  if (g) return describeGroup(gi, g);
  const n = gi.byId.get(id);

  if (!n) return null;

  if (n.kind === 'symbol') return describeSymbol(gi, n);

  if (n.kind === 'file') return describeFile(gi, n);

  if (n.kind === 'folder') return describeFolder(gi, n);

  return describeRepo(gi, n);
}
