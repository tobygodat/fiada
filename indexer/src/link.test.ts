// Edge evidence, router mounts, Go, ORM links and client-side pages, on small
// fixture repos shaped like the real ones they stand in for.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Graph, GraphEdge, RepoInfo } from '@strata/shared';
import { buildGraph } from './build.ts';
import { defaultGrouping } from './classify/index.ts';
import { matchRequest, segments } from './link.ts';
import { loadRepo } from './sources.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-link-'));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  return dir;
}

const info = (id: string): RepoInfo => ({ id, name: id, source: id, kind: 'local', status: 'indexing' });

async function graphOf(repos: Record<string, Record<string, string>>): Promise<Graph> {
  const parsed = [];
  for (const [id, files] of Object.entries(repos)) parsed.push(await loadRepo(info(id), await fixture(files)));
  return buildGraph(parsed, defaultGrouping());
}

const edge = (g: Graph, from: string, to: string, kind?: string): GraphEdge => {
  const e = g.edges.find((x) => x.from === from && x.to === to && (!kind || x.kind === kind));
  assert.ok(e, `expected an edge ${from} → ${to}${kind ? ` (${kind})` : ''}; have:\n${g.edges.map((x) => `  ${x.from} → ${x.to} ${x.kind}`).join('\n')}`);
  return e;
};
const node = (g: Graph, id: string) => {
  const n = g.nodes.find((x) => x.id === id);
  assert.ok(n, `no node ${id}`);
  return n;
};

const FASTAPI = {
  'app/__init__.py': '',
  'app/core/__init__.py': '',
  'app/core/config.py': 'class Settings:\n    API_V1_STR: str = "/api/v1"\n\nsettings = Settings()\n',
  'app/main.py':
    'from fastapi import FastAPI\nfrom app.api.main import api_router\nfrom app.core.config import settings\n\n' +
    'app = FastAPI()\napp.include_router(api_router, prefix=settings.API_V1_STR)\n',
  'app/api/__init__.py': '',
  'app/api/main.py': 'from fastapi import APIRouter\nfrom app.api.routes import items\n\napi_router = APIRouter()\napi_router.include_router(items.router)\n',
  'app/api/routes/__init__.py': '',
  'app/api/routes/items.py':
    'from fastapi import APIRouter\n\nrouter = APIRouter(prefix="/items")\n\n' +
    '@router.get("/{id}")\ndef read_item(id: str):\n    return id\n\n@router.get("/")\ndef read_items():\n    return []\n',
};

test('code edges carry the use site and the import they went through', async () => {
  const g = await graphOf({
    web: {
      'package.json': JSON.stringify({ name: 'web', dependencies: { react: '19' } }),
      'src/api.ts': 'export function getItem(id: string) {\n  return id;\n}\n',
      'src/Item.tsx': 'import { getItem } from "./api";\n\nexport function Item() {\n  getItem("1");\n  return <div />;\n}\n',
    },
  });
  const e = edge(g, 'web/src/Item.tsx#Item', 'web/src/api.ts#getItem', 'calls');
  assert.equal(e.basis, 'evidenced');
  assert.equal(e.confidence, 0.95);
  assert.match(e.reason!, /calls getItem, imported from "\.\/api"/);
  assert.deepEqual(
    e.evidence!.map((x) => [x.source, x.line, x.code]),
    [
      ['call', 4, 'getItem("1");'],
      ['import', 1, 'import { getItem } from "./api";'],
    ],
  );
  assert.ok(g.edges.every((x) => x.basis && x.evidence?.length && x.confidence! > 0), 'every edge has a basis and evidence');
});

test('FastAPI mounts give routes their full path, and an exact request is evidenced', async () => {
  const g = await graphOf({
    api: FASTAPI,
    web: {
      'package.json': JSON.stringify({ name: 'web', dependencies: { react: '19' } }),
      'src/client.ts':
        'export const getItem = (id: string) => fetch(`/api/v1/items/${id}`);\n' +
        'export const listItems = () => fetch(`${process.env.API_URL}/items/`);\n',
    },
  });
  assert.deepEqual(node(g, 'api/app/api/routes/items.py#read_item').routes, ['GET /api/v1/items/{id}']);

  const exact = edge(g, 'web/src/client.ts#getItem', 'api/app/api/routes/items.py#read_item', 'http');
  assert.equal(exact.basis, 'evidenced');
  assert.equal(exact.detail, 'GET /api/v1/items/{id}');
  assert.equal(exact.reason, "matches the route's full path GET /api/v1/items/{id} exactly, through 2 router mounts");
  const sources = exact.evidence!.map((x) => `${x.source} ${x.file.split('/').slice(1).join('/')}:${x.line}`);
  assert.deepEqual(sources, [
    'request src/client.ts:1',
    'route app/api/routes/items.py:5',
    'mount app/api/routes/items.py:3',
    'mount app/main.py:6',
    'constant app/core/config.py:2',
    'mount app/api/main.py:5',
  ]);
  assert.equal(exact.evidence![4].note, 'settings.API_V1_STR = "/api/v1"');

  // A base URL from the environment can't be read, so the match is a guess.
  const guess = edge(g, 'web/src/client.ts#listItems', 'api/app/api/routes/items.py#read_items', 'http');
  assert.equal(guess.basis, 'inferred');
  assert.match(guess.reason!, /base URL comes from process\.env\.API_URL/);
  assert.ok(guess.confidence! < exact.confidence!);
});

test('without the mount, a request that includes the prefix still matches, as inferred', async () => {
  const { 'app/main.py': _main, ...unmounted } = FASTAPI;
  const g = await graphOf({ api: unmounted, web: { 'src/c.ts': 'export const f = () => fetch("/api/v1/items/42");\n' } });
  assert.deepEqual(node(g, 'api/app/api/routes/items.py#read_item').routes, ['GET /items/{id}']);
  const e = edge(g, 'web/src/c.ts#f', 'api/app/api/routes/items.py#read_item', 'http');
  assert.equal(e.basis, 'inferred');
  assert.match(e.reason!, /mount prefix wasn't found/);
});

test('Express: app.use prefixes, and routes belong to their named handlers', async () => {
  const g = await graphOf({
    srv: {
      'package.json': JSON.stringify({ name: 'srv', dependencies: { express: '5' } }),
      'app.js': 'import express from "express";\nimport items from "./routes/items.js";\nconst app = express();\napp.use("/api/items", items);\n',
      'routes/items.js':
        'import { Router } from "express";\nimport { getItem } from "../controllers/items.js";\n' +
        'const router = Router();\nrouter.get("/:id", getItem);\nexport default router;\n',
      'controllers/items.js': 'export function getItem(req, res) {\n  res.json({});\n}\n',
    },
    web: { 'src/c.ts': 'export const f = (id: string) => fetch(`/api/items/${id}`);\n' },
  });
  assert.deepEqual(node(g, 'srv/controllers/items.js#getItem').routes, ['GET /api/items/:id']);
  const e = edge(g, 'web/src/c.ts#f', 'srv/controllers/items.js#getItem', 'http');
  assert.equal(e.basis, 'evidenced');
  assert.ok(e.evidence!.some((x) => x.source === 'mount' && x.code === 'app.use("/api/items", items);'));
});

test('Go: packages, gin groups passed into register functions, GORM entities', async () => {
  const g = await graphOf({
    api: {
      'go.mod': 'module github.com/acme/api\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgorm.io/gorm v1.25.12\n)\n',
      'main.go':
        'package main\n\nimport (\n\t"github.com/gin-gonic/gin"\n\t"github.com/acme/api/articles"\n)\n\n' +
        'func main() {\n\tr := gin.Default()\n\tv1 := r.Group("/api")\n\tarticles.Register(v1.Group("/articles"))\n\tr.Run()\n}\n',
      'articles/routers.go':
        'package articles\n\nimport "github.com/gin-gonic/gin"\n\n' +
        'func Register(router *gin.RouterGroup) {\n\trouter.GET("/:slug", Retrieve)\n\trouter.POST("", Create)\n}\n\n' +
        'func Retrieve(c *gin.Context) {\n\tFindOne(c.Param("slug"))\n}\n\nfunc Create(c *gin.Context) {}\n',
      'articles/models.go':
        'package articles\n\nimport "gorm.io/gorm"\n\n' +
        'type Article struct {\n\tgorm.Model\n\tSlug string `gorm:"uniqueIndex"`\n\tAuthor Author\n\tTags []Tag `gorm:"many2many:article_tags;"`\n}\n\n' +
        'type Tag struct {\n\tgorm.Model\n\tName string\n}\n\ntype Author struct {\n\tName string\n}\n\n' +
        'func FindOne(slug string) (Article, error) {\n\tvar a Article\n\treturn a, nil\n}\n',
    },
    web: { 'src/agent.js': 'const requests = { get: (u) => u };\nexport const Articles = { get: (slug) => requests.get(`/articles/${slug}`) };\n' },
  });
  const repo = g.repos[0];
  assert.deepEqual(repo.frameworks, ['gin', 'gorm']);
  assert.equal(repo.languages?.go, 3);

  // A call into another package, and one within the same package.
  const cross = edge(g, 'api/main.go#main', 'api/articles/routers.go#Register', 'calls');
  assert.equal(cross.basis, 'evidenced');
  assert.match(cross.reason!, /imported from "github.com\/acme\/api\/articles"/);
  assert.match(edge(g, 'api/articles/routers.go#Retrieve', 'api/articles/models.go#FindOne', 'calls').reason!, /same Go package/);

  assert.deepEqual(node(g, 'api/articles/routers.go#Retrieve').routes, ['GET /api/articles/:slug']);
  assert.deepEqual(node(g, 'api/articles/routers.go#Create').routes, ['POST /api/articles']);

  const table = (id: string) => node(g, id).facts?.some((f) => f.type === 'table');
  assert.ok(table('api/articles/models.go#Article') && table('api/articles/models.go#Tag'));
  assert.ok(!table('api/articles/models.go#Author'), 'a struct with no gorm.Model or tags is not an entity');
  assert.ok(edge(g, 'api/articles/models.go#Article', 'api/articles/models.go#Tag').evidence!.some((x) => x.source === 'orm'));

  // The JS client's path lacks the /api prefix a wrapper adds: matched, but only inferred.
  const http = edge(g, 'web/src/agent.js#Articles', 'api/articles/routers.go#Retrieve', 'http');
  assert.equal(http.basis, 'inferred');
  assert.equal(http.detail, 'GET /api/articles/:slug');
});

test('Go: method-first registrations, one route per listed method', async () => {
  const g = await graphOf({
    api: {
      'go.mod': 'module github.com/acme/api\n\ngo 1.22\n',
      'main.go':
        'package main\n\nimport (\n\t"net/http"\n\n\t"github.com/go-chi/chi/v5"\n\t"github.com/labstack/echo/v4"\n)\n\n' +
        'func main() {\n\tr := chi.NewRouter()\n\tr.Method(http.MethodGet, "/chi", h)\n\tr.MethodFunc("POST", "/chi", h2)\n\tr.Handle("/any", h3)\n' +
        '\te := echo.New()\n\te.Add("PUT", "/echo", h)\n\te.Match([]string{"GET", http.MethodPost}, "/match", h2)\n\tq := url.Values{}\n\tq.Add("next", "/home")\n}\n\n' +
        'func h(w http.ResponseWriter, r *http.Request)  {}\nfunc h2(w http.ResponseWriter, r *http.Request) {}\nfunc h3(w http.ResponseWriter, r *http.Request) {}\n',
    },
  });
  assert.deepEqual(node(g, 'api/main.go#h').routes, ['GET /chi', 'PUT /echo']);
  assert.deepEqual(node(g, 'api/main.go#h2').routes, ['POST /chi', 'GET /match', 'POST /match']);
  assert.deepEqual(node(g, 'api/main.go#h3').routes, ['* /any']);
  assert.equal(node(g, 'api/main.go#main').routes, undefined, 'q.Add("next", "/home") is not a route');
});

test('a router mounted under two prefixes serves both paths', async () => {
  const main =
    'from fastapi import FastAPI\nfrom app.api.routes import items\n\napp = FastAPI()\n' +
    'app.include_router(items.router, prefix="/api/v1")\napp.include_router(items.router, prefix="/api/v2")\n';
  const g = await graphOf({
    api: { ...FASTAPI, 'app/main.py': main },
    web: { 'src/c.ts': 'export const f = () => fetch("/api/v2/items/42");\n' },
  });
  assert.deepEqual(node(g, 'api/app/api/routes/items.py#read_item').routes, ['GET /api/v1/items/{id}', 'GET /api/v2/items/{id}']);
  const e = edge(g, 'web/src/c.ts#f', 'api/app/api/routes/items.py#read_item', 'http');
  assert.equal(e.basis, 'evidenced');
  assert.equal(e.detail, 'GET /api/v2/items/{id}');
  assert.ok(e.evidence!.some((x) => x.code === 'app.include_router(items.router, prefix="/api/v2")'));
});

test('Go: TableName() names the table wherever the method sits in the package', async () => {
  const g = await graphOf({
    api: {
      'go.mod': 'module github.com/acme/api\n\ngo 1.22\n',
      'models/tables.go': 'package models\n\nfunc (User) TableName() string { return "accounts" }\n\nfunc (Team) TableName() string { return "teams" }\n\ntype Team struct {\n\tName string\n}\n',
      'models/user.go': 'package models\n\ntype User struct {\n\tID   uint\n\tName string\n}\n',
      'other/user.go': 'package other\n\ntype User struct {\n\tName string\n}\n',
    },
  });
  const table = (id: string) => node(g, id).facts?.find((f) => f.type === 'table')?.value;
  assert.equal(table('api/models/user.go#User'), 'User', 'declared in another file');
  assert.equal(table('api/models/tables.go#Team'), 'Team', 'declared after the method');
  assert.equal(table('api/other/user.go#User'), undefined, 'a struct of the same name in another package');
});

test('SQLAlchemy: tables, relationships and foreign keys between entities', async () => {
  const g = await graphOf({
    db: {
      'app/__init__.py': '',
      'app/base.py': 'from sqlalchemy.orm import DeclarativeBase\n\nclass Base(DeclarativeBase):\n    pass\n',
      'app/models.py':
        'from sqlalchemy import Column, ForeignKey, Integer\nfrom sqlalchemy.orm import Mapped, mapped_column, relationship\nfrom app.base import Base\n\n' +
        'class User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n    addresses: Mapped[list["Address"]] = relationship(back_populates="user")\n\n' +
        'class Address(Base):\n    __tablename__ = "addresses"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    user_id = Column(ForeignKey("users.id"))\n',
    },
  });
  const table = (id: string) => node(g, id).facts?.some((f) => f.type === 'table');
  assert.ok(table('db/app/models.py#User') && table('db/app/models.py#Address'));
  assert.ok(!table('db/app/base.py#Base'), 'the declarative base itself is not a table');

  const fk = edge(g, 'db/app/models.py#Address', 'db/app/models.py#User');
  assert.equal(fk.basis, 'evidenced');
  assert.ok(fk.evidence!.some((x) => x.source === 'orm' && x.note === 'foreign key users.id'));
  const rel = edge(g, 'db/app/models.py#User', 'db/app/models.py#Address');
  assert.ok(rel.evidence!.some((x) => x.source === 'orm' && x.note === 'relationship to Address'));
});

test('client-side pages: TanStack file routes and React Router elements', async () => {
  const g = await graphOf({
    web: {
      'package.json': JSON.stringify({ name: 'web', dependencies: { react: '19' } }),
      'src/routes/_layout/items.$id.tsx':
        'import { createFileRoute } from "@tanstack/react-router";\n' +
        'export const Route = createFileRoute("/_layout/items/$id")({ component: Item });\nfunction Item() {\n  return <div />;\n}\n',
      'src/App.tsx':
        'import { Route, Routes } from "react-router-dom";\nimport Settings from "./Settings";\n' +
        'export function App() {\n  return (\n    <Routes>\n      <Route path="/account">\n        <Route path="settings" element={<Settings />} />\n      </Route>\n    </Routes>\n  );\n}\n',
      'src/Settings.tsx': 'export default function Settings() {\n  return <form />;\n}\n',
    },
  });
  const pages = (id: string) => node(g, id).facts?.filter((f) => f.type === 'pageRoute').map((f) => f.value);
  assert.deepEqual(pages('web/src/routes/_layout/items.$id.tsx'), ['/items/{id}']);
  assert.deepEqual(pages('web/src/routes/_layout/items.$id.tsx#Item'), ['/items/{id}']);
  assert.deepEqual(pages('web/src/Settings.tsx#Settings'), ['/account/settings']);
  assert.deepEqual(pages('web/src/Settings.tsx'), ['/account/settings']);
  assert.deepEqual(pages('web/src/App.tsx') ?? [], [], 'the file declaring the routes is not the page');
});

test('request matching aligns from the end and prefers exact full paths', () => {
  const route = (method: string, p: string, node: string, full = false) => ({ method, segs: segments(p), node, fullPath: full ? p : undefined });
  const routes = [
    route('GET', '/api/v1/users/me', 'me', true),
    route('GET', '/api/v1/users/{id}', 'byId', true),
    route('GET', '/items', 'items'),
  ];
  // A dynamic request segment prefers the parameter route over a literal one.
  const m = matchRequest(routes, 'GET', segments('/api/v1/users/{}'))!;
  assert.equal(m.route.node, 'byId');
  assert.ok(m.exact);
  assert.equal(matchRequest(routes, 'GET', segments('/api/v1/users/me'))!.route.node, 'me');
  // A request missing the base URL still lands on the route, not exactly.
  const tail = matchRequest(routes, 'GET', segments('/users/me'))!;
  assert.equal(tail.route.node, 'me');
  assert.equal(tail.exact, false);
  assert.equal(tail.longer, 'route');
  // Unknown base URL: never exact.
  assert.equal(matchRequest(routes, 'GET', segments('/api/v1/users/me'), false)!.exact, false);
  assert.equal(matchRequest(routes, 'POST', segments('/items')), null);
});
