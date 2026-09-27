// Default layer classifiers. Each one is a different kind of evidence:
//   code-signals      what the code does (declares routes, renders JSX, defines ORM models…)
//   path-conventions  where the file lives (routes/, components/, models.py…)
//   graph-position    who calls it (a file only API handlers call is probably a service)

import type { Layer } from '@strata/shared';
import type { LayerClassifier, Vote } from './types.ts';

const UI_LIBS = /^(react|react-dom|vue|svelte|solid-js|preact|@angular\/.*|react-native|@mui\/.*|@chakra-ui\/.*|@radix-ui\/.*|lucide-react|@headlessui\/.*|tailwind-merge|framer-motion)$/;
const HTTP_CLIENTS = /^(axios|ky|ofetch|got|node-fetch|cross-fetch|swr|graphql-request|@apollo\/client|requests|httpx|aiohttp|urllib3)$/;
const ORM = /^(sqlalchemy|sqlmodel|alembic|django|peewee|tortoise|pymongo|motor|redis|psycopg2?|asyncpg|prisma|@prisma\/client|mongoose|typeorm|drizzle-orm|knex|pg|mysql2|sequelize|ioredis|better-sqlite3|kysely)$/;
const SERVER_LIBS = /^(fastapi|flask|starlette|django|express|fastify|hono|koa|@nestjs\/.*|next\/server)$/;
const PIPELINE_LIBS = /^(airflow|celery|prefect|dagster|luigi|dask|pyspark|ray|kafka|confluent_kafka|bullmq|bull|agenda|torch|tensorflow|sklearn|scikit-learn|pandas|polars|numpy|transformers)$/;
const ORM_BASES = /(^|\.)(Base|DeclarativeBase|Model|Document|Entity)$|^table=True$/;
const SCHEMA_BASES = /(^|\.)(BaseModel|SQLModel|TypedDict|Schema|BaseSettings|Enum|IntEnum|StrEnum|Protocol|NamedTuple)$/;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const codeSignals: LayerClassifier = {
  name: 'code-signals',
  classifyFile({ file, externalImports, frontend }): Vote<Layer> | null {
    const routes = file.routes.length + file.symbols.reduce((n, s) => n + (s.routes?.length ?? 0), 0);
    const nextRoute = /(^|\/)app\/(.*\/)?route\.[cm]?[jt]sx?$|(^|\/)pages\/api\//.test(file.path);
    if (routes || nextRoute) {
      const first = file.symbols.find((s) => s.routes?.length)?.routes?.[0] ?? file.routes[0];
      const example = first ? ` (${first.method} ${first.path})` : '';
      return { value: 'API', confidence: 0.9, reason: nextRoute ? 'Next.js route handler' : `declares ${plural(routes, 'route')}${example}` };
    }
    const components = file.symbols.filter((s) => s.kind === 'component').length;
    if (file.jsx || components) {
      return { value: 'UI', confidence: 0.85, reason: components ? `renders JSX (${plural(components, 'component')})` : 'renders JSX' };
    }
    const ormModels = file.symbols.filter((s) => s.kind === 'class' && s.bases?.some((b) => ORM_BASES.test(b)));
    if (ormModels.length) return { value: 'Storage', confidence: 0.8, reason: `defines ${plural(ormModels.length, 'ORM model')} (${ormModels[0].name})` };

    const requests = file.requests.length + file.symbols.reduce((n, s) => n + (s.requests?.length ?? 0), 0);
    if (requests) return { value: 'Client', confidence: 0.8, reason: `makes ${plural(requests, 'HTTP request')}` };

    const orm = externalImports.find((m) => ORM.test(m));
    const server = externalImports.find((m) => SERVER_LIBS.test(m));
    const pipeline = externalImports.find((m) => PIPELINE_LIBS.test(m));
    const http = externalImports.find((m) => HTTP_CLIENTS.test(m));
    const ui = externalImports.find((m) => UI_LIBS.test(m));

    const syms = file.symbols;
    const typeOnly = syms.length > 0 && syms.every((s) => s.kind === 'interface' || s.kind === 'type' || s.kind === 'enum');
    const schemaOnly =
      syms.length > 0 &&
      syms.every((s) => (s.kind === 'class' || s.kind === 'enum' || s.kind === 'interface') && s.bases?.some((b) => SCHEMA_BASES.test(b)));
    if (typeOnly) return { value: 'Contracts', confidence: 0.75, reason: `only declares types (${plural(syms.length, 'type')})` };
    if (schemaOnly) return { value: 'Contracts', confidence: 0.7, reason: `only declares schemas (${syms[0].bases?.find((b) => SCHEMA_BASES.test(b))})` };

    if (orm) return { value: 'Storage', confidence: 0.65, reason: `imports ${orm}` };
    if (pipeline) return { value: 'Pipeline', confidence: 0.6, reason: `imports ${pipeline}` };
    if (http) return { value: 'Client', confidence: 0.6, reason: `imports ${http}` };
    if (server) return { value: 'API', confidence: 0.55, reason: `imports ${server}` };
    if (ui && frontend) return { value: 'UI', confidence: 0.55, reason: `imports ${ui}` };
    return null;
  },
  classifySymbol(sym, file): Vote<Layer> | null {
    // A models module often mixes table models (Storage) with request/response schemas (Contracts).
    if (sym.kind === 'class' && sym.bases?.some((b) => ORM_BASES.test(b)) && file.value !== 'Storage') {
      return { value: 'Storage', confidence: 0.8, reason: `ORM model (${sym.bases.find((b) => ORM_BASES.test(b))})` };
    }
    if ((sym.kind === 'class' || sym.kind === 'enum' || sym.kind === 'interface') && sym.bases?.some((b) => SCHEMA_BASES.test(b)) && !sym.bases.some((b) => ORM_BASES.test(b))) {
      return { value: 'Contracts', confidence: 0.75, reason: `schema class (${sym.bases.find((b) => SCHEMA_BASES.test(b))})` };
    }
    if ((sym.kind === 'interface' || sym.kind === 'type') && file.value !== 'Contracts') {
      return { value: 'Contracts', confidence: 0.6, reason: `${sym.kind} declaration` };
    }
    if (sym.routes?.length) return { value: 'API', confidence: 0.9, reason: `serves ${sym.routes[0].method} ${sym.routes[0].path}` };
    if (sym.kind === 'component' && file.value !== 'UI') return { value: 'UI', confidence: 0.85, reason: 'React component' };
    if (sym.requests?.length && file.value !== 'Client') return { value: 'Client', confidence: 0.8, reason: `requests ${sym.requests[0].method} ${sym.requests[0].path}` };
    return null;
  },
};

// Directory and file-name conventions. `frontend` flips the meaning of
// ambiguous names like "api/" (a client wrapper in a web app, the HTTP surface
// in a server).
const SEGMENTS: [RegExp, Layer | ((frontend: boolean) => Layer)][] = [
  [/^(components?|pages|views|screens|layouts?|ui|widgets|templates|app)$/, (fe) => (fe ? 'UI' : 'Other')],
  [/^(routes?|routers?|controllers?|handlers?|endpoints?|resolvers|views)$/, (fe) => (fe ? 'UI' : 'API')],
  [/^(api|apis)$/, (fe) => (fe ? 'Client' : 'API')],
  [/^(client|clients|sdk|lib|hooks|store|stores|state|queries|services)$/, (fe) => (fe ? 'Client' : 'Services')],
  [/^(domain|usecases?|core|logic|business|crud)$/, 'Services'],
  [/^(db|database|models?|entities|repositories|repos?|migrations|alembic|prisma|dao|orm|persistence|storage)$/, 'Storage'],
  [/^(jobs?|workers?|tasks?|pipelines?|etl|dags?|cron|queues?|consumers?|ingest|scripts|ml|training)$/, 'Pipeline'],
  [/^(types|contracts|schemas?|interfaces|proto|protos|dto|dtos|shared|common)$/, 'Contracts'],
];
const FILE_NAMES: [RegExp, Layer][] = [
  [/\.(controller|route|routes|router|handler|resolver)\.[jt]sx?$|^(routes|views|urls|endpoints)\.py$/, 'API'],
  [/\.(service|usecase)\.[jt]sx?$|^(services?|crud|logic)\.py$/, 'Services'],
  [/\.(repository|repo|entity|model|schema\.prisma)\.[jt]sx?$|^(models|db|database|repository|orm)\.py$/, 'Storage'],
  [/\.(dto|types?|d)\.[jt]sx?$|^(schemas?|types|dto)\.py$/, 'Contracts'],
  [/^(tasks|jobs|worker|celery|pipeline|dag)\.py$|\.(job|worker|task)\.[jt]sx?$/, 'Pipeline'],
  [/^use[A-Z].*\.[jt]sx?$|^(api|client|fetcher)\.[jt]sx?$/, 'Client'],
];

export const pathConventions: LayerClassifier = {
  name: 'path-conventions',
  classifyFile({ file, frontend }): Vote<Layer> | null {
    const segs = file.path.split('/');
    const base = segs.pop()!;
    for (const [re, layer] of FILE_NAMES) if (re.test(base)) return { value: layer, confidence: 0.6, reason: `file name "${base}"` };
    // Deepest directory that means something wins.
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i].toLowerCase();
      for (const [re, layer] of SEGMENTS) {
        if (!re.test(seg)) continue;
        const value = typeof layer === 'function' ? layer(frontend) : layer;
        if (value === 'Other') continue;
        return { value, confidence: 0.5, reason: `lives under ${segs.slice(0, i + 1).join('/')}/` };
      }
    }
    return null;
  },
};

/**
 * Second pass: files nothing else claimed get a layer from their neighbours.
 * A file whose callers are mostly API handlers is a service; one whose callers
 * are mostly UI is client-side plumbing.
 */
export const graphPosition: LayerClassifier = {
  name: 'graph-position',
  phase: 'graph',
  classifyFile({ callers, callees, layerOf }): Vote<Layer> | null {
    if (!layerOf || !callers.length) return null;
    const tally = new Map<Layer, number>();
    for (const c of callers) {
      const l = layerOf(c);
      if (l && l !== 'Other') tally.set(l, (tally.get(l) ?? 0) + 1);
    }
    const [top, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!top || n / callers.length < 0.5) return null;
    const callsStorage = callees.some((c) => layerOf(c) === 'Storage');
    const map: Partial<Record<Layer, Layer>> = { API: 'Services', Services: callsStorage ? 'Storage' : 'Services', UI: 'Client', Client: 'Client', Pipeline: 'Pipeline' };
    const value = map[top];
    if (!value) return null;
    return { value, confidence: 0.4, reason: `${n} of ${plural(callers.length, 'caller')} are ${top}` };
  },
};
