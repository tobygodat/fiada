// Starting points for a project's layers. A preset is plain data, copied into
// the project's grouping file on first run; after that the project owns it
// and can rename, delete, add and re-target layers freely.

import type { Grouping, LayerDef, LayerMatcher, LayerPreset, RepoInfo } from '@fiada/shared';

// Priority bands: facts 300 > imports 200 > file names 120 > frontend-only folders 110 > folders 100 > repos 50.
// Inside a band, a small offset settles common ties (a file importing both
// react and axios is a client; one importing fastapi and sqlmodel is data access).
const fact = (type: NonNullable<LayerMatcher['fact']>['type'], value?: string, priority = 300): LayerMatcher => ({
  fact: value ? { type, value } : { type },
  priority,
});

const imports = (priority: number, ...pkgs: string[]): LayerMatcher[] => pkgs.map((p) => ({ import: p, priority }));
const dirs = (priority: number, ...names: string[]): LayerMatcher[] => names.map((d) => ({ path: `**/${d}/**`, priority }));
const files = (priority: number, ...globs: string[]): LayerMatcher[] => globs.map((g) => ({ path: `**/${g}`, priority }));

/** Folder names that mean something else in a frontend package (a web app's "api/" wraps fetch calls). */
const frontendDirs = (...names: string[]): LayerMatcher[] => names.map((d) => ({ path: `**/${d}/**`, fact: { type: 'frontend' }, priority: 110 }));

/**
 * Roles in the request flow. Pipeline code spreads across these by what it
 * does (its HTTP calls are client, its scheduled entry points are jobs), and
 * repository colour still shows where it came from.
 */
export function rolesPreset(): LayerDef[] {
  return [
    {
      id: 'ui',
      name: 'UI',
      rank: 1,
      match: [
        fact('returnsJSX'),
        fact('pageRoute'),
        ...imports(190, 'react', 'react-dom', 'vue', 'svelte', 'solid-js', 'preact', '@angular/core', 'react-native'),
        ...frontendDirs('pages', 'views', 'routes', 'app', 'screens'),
        ...dirs(100, 'components', 'widgets', 'layouts', 'ui'),
      ],
    },
    {
      id: 'client',
      name: 'Client',
      rank: 2,
      match: [
        fact('request', undefined, 250),
        ...imports(220, 'axios', 'ky', 'ofetch', 'got', 'node-fetch', 'cross-fetch', 'swr', 'graphql-request', '@apollo/client', '@tanstack/react-query', 'requests', 'httpx', 'aiohttp'),
        // Go HTTP clients.
        ...imports(220, 'github.com/go-resty/resty', 'github.com/hashicorp/go-retryablehttp'),
        ...files(120, 'use[A-Z]*.ts', 'api.ts', 'client.ts', 'fetcher.ts'),
        ...frontendDirs('api', 'apis', 'lib', 'hooks', 'store', 'stores', 'state', 'queries', 'services'),
        ...dirs(100, 'client', 'clients', 'sdk'),
      ],
    },
    {
      id: 'api',
      name: 'API',
      rank: 3,
      match: [
        fact('route'),
        ...imports(200, 'fastapi', 'flask', 'starlette', 'django.http', 'django.urls', 'rest_framework', 'express', 'fastify', 'hono', 'koa', '@nestjs/common', 'next/server'),
        // Go web frameworks and RPC servers.
        ...imports(200, 'github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/go-chi/chi', 'github.com/gofiber/fiber', 'github.com/gorilla/mux', 'github.com/julienschmidt/httprouter', 'google.golang.org/grpc'),
        ...files(120, '*.controller.*', '*.route.*', '*.routes.*', '*.router.*', '*.handler.*', '*.resolver.*', 'routes.py', 'views.py', 'urls.py', 'endpoints.py'),
        ...dirs(100, 'routes', 'routers', 'controllers', 'handlers', 'endpoints', 'resolvers', 'api', 'views'),
      ],
    },
    {
      id: 'service',
      name: 'Service',
      rank: 4,
      match: [
        ...imports(200, 'torch', 'tensorflow', 'sklearn', 'jax', 'transformers', 'xgboost', 'lightgbm'),
        ...files(120, '*.service.*', '*.usecase.*', 'services.py', 'service.py', 'logic.py'),
        ...dirs(100, 'services', 'service', 'domain', 'usecases', 'core', 'logic', 'business'),
      ],
    },
    {
      id: 'data',
      name: 'Data',
      rank: 5,
      match: [
        fact('table', undefined, 310),
        ...imports(210, 'sqlalchemy', 'sqlmodel', 'alembic', 'django.db', 'peewee', 'tortoise', 'pymongo', 'motor', 'redis', 'psycopg', 'psycopg2', 'asyncpg', 'prisma', '@prisma/client', 'mongoose', 'typeorm', 'drizzle-orm', 'knex', 'pg', 'mysql2', 'sequelize', 'ioredis', 'better-sqlite3', 'kysely'),
        // Go database drivers and ORMs.
        ...imports(210, 'gorm.io/gorm', 'gorm.io/driver', 'github.com/jinzhu/gorm', 'database/sql', 'github.com/jmoiron/sqlx', 'github.com/jackc/pgx', 'github.com/lib/pq', 'go.mongodb.org/mongo-driver', 'github.com/redis/go-redis', 'entgo.io/ent'),
        ...files(120, '*.repository.*', '*.entity.*', '*.model.*', 'models.py', 'db.py', 'database.py', 'repository.py', 'orm.py', 'crud.py'),
        // "models/" is ambiguous on purpose: an import of torch outranks it.
        ...dirs(100, 'db', 'database', 'models', 'entities', 'repositories', 'migrations', 'alembic', 'prisma', 'dao', 'orm', 'persistence'),
      ],
    },
    {
      id: 'job',
      name: 'Job',
      match: [
        fact('entrypoint', '^(cron|dag)$'),
        fact('decorator', '(^|\\.)(task|shared_task|periodic_task|dag|flow|scheduled_job|cron)$'),
        ...imports(230, 'airflow', 'celery', 'prefect', 'dagster', 'luigi', 'bullmq', 'bull', 'agenda', 'apscheduler', 'rq', 'dramatiq', 'node-cron'),
        ...imports(230, 'github.com/hibiken/asynq', 'github.com/robfig/cron', 'github.com/go-co-op/gocron'),
        ...files(120, 'tasks.py', 'jobs.py', 'worker.py', 'celery.py', 'dag.py', '*.job.*', '*.worker.*', '*.task.*'),
        ...dirs(100, 'jobs', 'workers', 'tasks', 'pipelines', 'etl', 'dags', 'cron', 'queues', 'consumers'),
      ],
    },
    {
      id: 'contract',
      name: 'Contract',
      match: [
        fact('typeOnly'),
        // Symbol-level: a schema class inside a models or routes file.
        fact('extends', '(^|\\.)(BaseModel|SQLModel|TypedDict|Schema|Protocol|NamedTuple)$', 290),
        ...files(120, '*.dto.*', '*.types.*', 'types.ts', 'schemas.py', 'schema.py', 'types.py', 'dto.py'),
        ...dirs(100, 'types', 'contracts', 'schemas', 'interfaces', 'proto', 'protos', 'dto', 'dtos'),
      ],
    },
    {
      id: 'test',
      name: 'Test',
      match: [fact('test'), ...dirs(100, 'tests', '__tests__', 'e2e'), ...files(120, '*.test.*', '*.spec.*', 'test_*.py', '*_test.py')],
    },
  ];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';

/** One layer per repository: the map's By function view then splits each domain by repo. */
export function byRepoPreset(repos: Pick<RepoInfo, 'id' | 'name'>[]): LayerDef[] {
  return repos.map((r) => ({ id: slug(r.id), name: r.name, match: [{ repo: r.id, priority: 50 }] }));
}

export const PRESETS: LayerPreset[] = ['roles', 'by-repo', 'empty'];

export function presetLayers(preset: LayerPreset, repos: Pick<RepoInfo, 'id' | 'name'>[]): LayerDef[] {
  if (preset === 'roles') return rolesPreset();

  if (preset === 'by-repo') return byRepoPreset(repos);

  return [];
}

export function defaultGrouping(preset: LayerPreset = 'roles', repos: Pick<RepoInfo, 'id' | 'name'>[] = []): Grouping {
  return { schema: 1, preset, layers: presetLayers(preset, repos), domains: [], rules: [], pins: {} };
}
