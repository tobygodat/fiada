// Java, Kotlin, C#, Rust, C, C++, Ruby and Swift: the symbols each file
// declares, and the links between files that each language's own rules for
// finding a name establish (packages, namespaces, modules, includes, requires).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Graph, GraphEdge, RepoInfo } from '@fiada/shared';
import { buildGraph } from './build.ts';
import { defaultGrouping } from './classify/index.ts';
import { parseFile } from './parse/index.ts';
import { loadRepo, TEST_PATH } from './sources.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-lang-'));
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
const noEdge = (g: Graph, from: string, to: string) => assert.ok(!g.edges.some((x) => x.from === from && x.to === to), `unexpected edge ${from} → ${to}`);
const node = (g: Graph, id: string) => {
  const n = g.nodes.find((x) => x.id === id);
  assert.ok(n, `no node ${id}; have:\n${g.nodes.map((x) => `  ${x.id}`).join('\n')}`);
  return n;
};

test('Java: packages, imports, wildcards, Spring routes, and a client request that reaches one', async () => {
  const g = await graphOf({
    api: {
      'src/main/java/com/acme/shop/ItemController.java':
        'package com.acme.shop;\n\nimport com.acme.shop.model.Item;\nimport com.acme.util.*;\n\n' +
        '@RestController\n@RequestMapping("/api/items")\npublic class ItemController {\n' +
        '  private final ItemService service = new ItemService();\n\n' +
        '  @GetMapping("/{id}")\n  public Item get(@PathVariable long id) {\n    Strings.trim("x");\n    return service.find(id);\n  }\n\n' +
        '  @PostMapping\n  public Item create(Item item) { return this.save(item); }\n\n' +
        '  private Item save(Item item) { return item; }\n}\n',
      'src/main/java/com/acme/shop/ItemService.java':
        'package com.acme.shop;\n\nimport com.acme.shop.model.Item;\n\npublic class ItemService {\n  public Item find(long id) { return new Item(id); }\n}\n',
      'src/main/java/com/acme/shop/model/Item.java': 'package com.acme.shop.model;\n\npublic record Item(long id) {}\n',
      'src/main/java/com/acme/util/Strings.java': 'package com.acme.util;\n\npublic final class Strings {\n  public static String trim(String s) { return s.trim(); }\n}\n',
    },
    web: { 'src/api.ts': 'export const getItem = (id: string) => fetch(`/api/items/${id}`);\n' },
  });
  const dir = 'api/src/main/java/com/acme';
  assert.equal(g.repos.find((r) => r.id === 'api')?.languages?.java, 4);
  assert.equal(node(g, `${dir}/shop/ItemController.java#ItemController.get`).symbolKind, 'function');

  // Same package: no import needed.
  const same = edge(g, `${dir}/shop/ItemController.java#ItemController`, `${dir}/shop/ItemService.java#ItemService`, 'calls');
  assert.match(same.reason!, /declared in package com\.acme\.shop/);
  // An explicit import, and a wildcard one.
  assert.match(edge(g, `${dir}/shop/ItemService.java#ItemService.find`, `${dir}/shop/model/Item.java#Item`, 'calls').reason!, /imported from "com\.acme\.shop\.model\.Item"/);
  assert.match(edge(g, `${dir}/shop/ItemController.java#ItemController.get`, `${dir}/util/Strings.java#Strings.trim`, 'calls').reason!, /imported from "com\.acme\.util"/);
  // this.save() is the sibling method.
  edge(g, `${dir}/shop/ItemController.java#ItemController.create`, `${dir}/shop/ItemController.java#ItemController.save`, 'calls');

  assert.deepEqual(node(g, `${dir}/shop/ItemController.java#ItemController.get`).routes, ['GET /api/items/{id}']);
  assert.deepEqual(node(g, `${dir}/shop/ItemController.java#ItemController.create`).routes, ['POST /api/items']);
  const http = edge(g, 'web/src/api.ts#getItem', `${dir}/shop/ItemController.java#ItemController.get`, 'http');
  assert.equal(http.detail, 'GET /api/items/{id}');
});

test('Java: static wildcard imports bring in members; a package in two repositories prefers the referring one', async () => {
  const g = await graphOf({
    one: {
      'src/com/acme/util/Strings.java': 'package com.acme.util;\n\npublic final class Strings {\n  public static String trim(String s) { return s; }\n}\n',
      'src/com/acme/Item.java': 'package com.acme;\n\npublic class Item {}\n',
      'src/com/acme/Use.java':
        'package com.acme;\n\nimport static com.acme.util.Strings.*;\n\npublic class Use {\n  String run() { new Item(); return trim("x"); }\n}\n',
    },
    two: {
      'src/com/acme/Item.java': 'package com.acme;\n\npublic class Item {}\n',
      'src/com/acme/Other.java': 'package com.acme;\n\npublic class Other {\n  Item make() { return new Item(); }\n}\n',
    },
  });
  assert.match(edge(g, 'one/src/com/acme/Use.java#Use.run', 'one/src/com/acme/util/Strings.java#Strings.trim', 'calls').reason!, /imported from "com\.acme\.util\.Strings"/);
  assert.equal(edge(g, 'two/src/com/acme/Other.java#Other.make', 'two/src/com/acme/Item.java#Item', 'calls').basis, 'evidenced');
  noEdge(g, 'two/src/com/acme/Other.java#Other.make', 'one/src/com/acme/Item.java#Item');
  edge(g, 'one/src/com/acme/Use.java#Use.run', 'one/src/com/acme/Item.java#Item', 'calls');
});

test('Java: a nested type named with its outer one, from the same package', async () => {
  const g = await graphOf({
    app: {
      'src/com/acme/Outer.java': 'package com.acme;\n\npublic class Outer {\n  public static class Inner {}\n}\n',
      'src/com/acme/Use.java': 'package com.acme;\n\npublic class Use {\n  Outer.Inner make() { return new Outer.Inner(); }\n}\n',
    },
  });
  edge(g, 'app/src/com/acme/Use.java#Use.make', 'app/src/com/acme/Outer.java#Outer.Inner', 'calls');
});

test('Java and C#: a qualified type is looked for where its qualifier says, not taken for a same-named one', async () => {
  const g = await graphOf({
    jv: {
      'src/external/api/Widget.java': 'package external.api;\n\npublic class Widget {}\n',
      'src/com/acme/Widget.java': 'package com.acme;\n\npublic class Widget {}\n',
      'src/com/acme/Use.java': 'package com.acme;\n\npublic class Use {\n  Object make() { java.util.List<String> l = null; return new external.api.Widget(); }\n}\n',
    },
    cs: {
      'External/Item.cs': 'namespace External.Models;\n\npublic class Item { }\n',
      'Acme/Item.cs': 'namespace Acme;\n\npublic class Item { }\n',
      'Acme/Models/Thing.cs': 'namespace Acme.Models;\n\npublic class Thing { public class Part { } }\n',
      'Acme/Use.cs': 'namespace Acme;\n\npublic class Use\n{\n    public object Make() { var t = new Models.Thing.Part(); return new External.Models.Item(); }\n}\n',
    },
  });
  assert.match(edge(g, 'jv/src/com/acme/Use.java#Use.make', 'jv/src/external/api/Widget.java#Widget', 'calls').reason!, /by its full path/);
  noEdge(g, 'jv/src/com/acme/Use.java#Use.make', 'jv/src/com/acme/Widget.java#Widget');
  edge(g, 'cs/Acme/Use.cs#Use.Make', 'cs/External/Item.cs#Item', 'calls');
  noEdge(g, 'cs/Acme/Use.cs#Use.Make', 'cs/Acme/Item.cs#Item');
  // Relative to the namespace the code is in, and nested in a type.
  edge(g, 'cs/Acme/Use.cs#Use.Make', 'cs/Acme/Models/Thing.cs#Thing.Part', 'calls');
});

test('Java and C#: qualified static calls; every mapped path, with the class prefix as evidence', async () => {
  const g = await graphOf({
    jv: {
      'src/partner/api/Util.java': 'package partner.api;\n\npublic class Util {\n  public static void run() {}\n  public static class Inner {\n    public static void make() {}\n  }\n}\n',
      'src/com/acme/Api.java':
        'package com.acme;\n\n@RestController\n@RequestMapping(path = {"/api", "/v1"})\npublic class Api {\n' +
        '  @GetMapping({"/current", "/legacy"})\n  public void get() {\n    partner.api.Util.run();\n    partner.api.Util.Inner.make();\n  }\n}\n',
    },
    cs: {
      'Util.cs': 'namespace External.Models;\n\npublic static class Util\n{\n    public static void Run() { }\n    public static class Inner { public static void Create() { } }\n}\n',
      'Use.cs': 'namespace Acme;\n\npublic class Use\n{\n    public void Go() { External.Models.Util.Run(); External.Models.Util.Inner.Create(); }\n}\n',
    },
    web: { 'src/api.ts': 'export const legacy = () => fetch(`/v1/legacy`);\n' },
  });
  const get = 'jv/src/com/acme/Api.java#Api.get';
  edge(g, get, 'jv/src/partner/api/Util.java#Util.run', 'calls');
  edge(g, get, 'jv/src/partner/api/Util.java#Util.Inner.make', 'calls');
  assert.deepEqual(node(g, get).routes?.slice().sort(), ['GET /api/current', 'GET /api/legacy', 'GET /v1/current', 'GET /v1/legacy']);
  const http = edge(g, 'web/src/api.ts#legacy', get, 'http');
  assert.ok(http.evidence!.some((x) => x.line === 4 && x.code?.includes('@RequestMapping')), 'cites the class-level prefix');
  edge(g, 'cs/Use.cs#Use.Go', 'cs/Util.cs#Util.Run', 'calls');
  edge(g, 'cs/Use.cs#Use.Go', 'cs/Util.cs#Util.Inner.Create', 'calls');
});

test('Kotlin: sees Java in its package, aliases imports, and reads Spring routes', async () => {
  const g = await graphOf({
    app: {
      'src/main/kotlin/com/acme/Repo.java': 'package com.acme;\n\npublic class Repo {\n  public String load() { return ""; }\n}\n',
      'src/main/kotlin/com/acme/util/Clock.kt': 'package com.acme.util\n\nfun now(): Long = 0\n\nclass Timer\n',
      'src/main/kotlin/com/acme/Service.kt':
        'package com.acme\n\nimport com.acme.util.Timer as T\nimport com.acme.util.now\n\n' +
        '@RestController\nclass Service(private val repo: Repo) {\n' +
        '    @GetMapping("/items")\n    fun list(): String {\n        now()\n        T()\n        return repo.load()\n    }\n}\n',
    },
  });
  const dir = 'app/src/main/kotlin/com/acme';
  assert.match(edge(g, `${dir}/Service.kt#Service`, `${dir}/Repo.java#Repo`, 'type').reason!, /package com\.acme/);
  assert.match(edge(g, `${dir}/Service.kt#Service.list`, `${dir}/util/Clock.kt#now`, 'calls').reason!, /imported from "com\.acme\.util\.now"/);
  edge(g, `${dir}/Service.kt#Service.list`, `${dir}/util/Clock.kt#Timer`, 'calls');
  assert.deepEqual(node(g, `${dir}/Service.kt#Service.list`).routes, ['GET /items']);
});

test('Kotlin fully qualified calls, and C# namespace aliases', async () => {
  const g = await graphOf({
    kt: {
      'src/partner/api/Widget.kt': 'package partner.api\n\nclass Widget\n\nobject Util {\n    fun run() {}\n}\n',
      'src/com/acme/Use.kt': 'package com.acme\n\nfun make() {\n    partner.api.Widget()\n    partner.api.Util.run()\n}\n',
    },
    cs: {
      'External/Item.cs': 'namespace External.Models;\n\npublic class Item { }\n',
      'Models/Item.cs': 'namespace Models;\n\npublic class Item { }\n',
      'Use.cs': 'using Models = External.Models;\n\nnamespace Acme;\n\npublic class Use\n{\n    public object Make() => new Models.Item();\n}\n',
    },
  });
  edge(g, 'kt/src/com/acme/Use.kt#make', 'kt/src/partner/api/Widget.kt#Widget', 'calls');
  edge(g, 'kt/src/com/acme/Use.kt#make', 'kt/src/partner/api/Widget.kt#Util.run', 'calls');
  noEdge(g, 'cs/Use.cs', 'cs/External');
  // The alias, not the real namespace Models.
  assert.match(edge(g, 'cs/Use.cs#Use.Make', 'cs/External/Item.cs#Item', 'calls').reason!, /imported from "External\.Models"/);
  noEdge(g, 'cs/Use.cs#Use.Make', 'cs/Models/Item.cs#Item');
});

test('C#: namespaces and their parents, usings, controller and minimal-API routes', async () => {
  const g = await graphOf({
    api: {
      'Models/Item.cs': 'namespace Acme.Models;\n\npublic record Item(int Id);\n',
      'Core/Clock.cs': 'namespace Acme;\n\npublic static class Clock { public static int Now() => 0; }\n',
      'Controllers/ItemsController.cs':
        'using Acme.Models;\nusing Microsoft.AspNetCore.Mvc;\n\nnamespace Acme.Controllers;\n\n' +
        '[ApiController]\n[Route("api/[controller]")]\npublic class ItemsController : ControllerBase\n{\n' +
        '    [HttpGet("{id}")]\n    public Item Get(int id) { Clock.Now(); return new Item(id); }\n}\n',
      'Program.cs':
        'var app = WebApplication.Create();\nvar api = app.MapGroup("/v2");\napi.MapGet("/health", () => "ok");\n' +
        'app.MapMethods("/items", new[] { "GET", HttpMethods.Put }, () => "ok");\napp.Run();\n',
    },
  });
  assert.match(edge(g, 'api/Controllers/ItemsController.cs#ItemsController.Get', 'api/Models/Item.cs#Item', 'calls').reason!, /imported from "Acme\.Models"/);
  // Acme.Controllers sees Acme without a using.
  assert.match(edge(g, 'api/Controllers/ItemsController.cs#ItemsController.Get', 'api/Core/Clock.cs#Clock.Now', 'calls').reason!, /namespace Acme\b/);
  assert.deepEqual(node(g, 'api/Controllers/ItemsController.cs#ItemsController.Get').routes, ['GET /api/Items/{id}']);
  assert.deepEqual(node(g, 'api/Program.cs').routes, ['GET /v2/health', 'GET /items', 'PUT /items']);
  assert.ok(g.edges.every((e) => !e.to.startsWith('ns:')), 'namespaces reach edges as their folders');
});

test('C#: each type belongs to the namespace around it, nested ones included', async () => {
  const g = await graphOf({
    api: {
      'Shapes.cs': 'namespace A\n{\n    namespace B\n    {\n        public class Circle { }\n    }\n    public class Square { }\n}\nnamespace C\n{\n    public class Circle { }\n}\n',
      'Use.cs': 'using A.B;\n\nnamespace D;\n\npublic class Use\n{\n    public void Run() { new Circle(); }\n}\n',
      'Other.cs': 'namespace A;\n\npublic class Other\n{\n    public void Run() { new Square(); }\n}\n',
      'Foo.cs': 'namespace B;\n\npublic class Foo { }\n',
      'Mixed.cs': 'namespace A\n{\n    public class Mixed { Foo f; }\n}\nnamespace B\n{\n    public class Late { Foo f; }\n}\n',
      'Scoped.cs': 'namespace A\n{\n    using B;\n    public class In { Foo f; }\n}\nnamespace C\n{\n    public class Out { Foo f; }\n}\n',
    },
  });
  // Code in namespace A of a file that also declares namespace B doesn't see B's names.
  noEdge(g, 'api/Mixed.cs#Mixed', 'api/Foo.cs#Foo');
  edge(g, 'api/Mixed.cs#Late', 'api/Foo.cs#Foo', 'type');
  // A using inside namespace A's block isn't seen from namespace C's.
  assert.match(edge(g, 'api/Scoped.cs#In', 'api/Foo.cs#Foo', 'type').reason!, /imported from "B"/);
  noEdge(g, 'api/Scoped.cs#Out', 'api/Foo.cs#Foo');
  // A.B's Circle, not C's, and not one filed under A or a top-level B.
  assert.match(edge(g, 'api/Use.cs#Use.Run', 'api/Shapes.cs#Circle', 'calls').reason!, /imported from "A\.B"/);
  assert.match(edge(g, 'api/Other.cs#Other.Run', 'api/Shapes.cs#Square', 'calls').reason!, /namespace A\b/);
});

test('Rust 2015: a use path from a nested module starts at the crate root', async () => {
  const g = await graphOf({
    old: {
      'Cargo.toml': '[package]\nname = "old"\nedition = "2015"\n',
      'src/lib.rs': 'mod model;\nmod api;\n',
      'src/model.rs': 'pub struct Item;\n',
      'src/api/mod.rs': 'use model::Item;\n\npub fn get() -> Item { Item }\n',
    },
  });
  assert.match(edge(g, 'old/src/api/mod.rs#get', 'old/src/model.rs#Item').reason!, /imported from "model::Item"/);
});

test('C#: global usings reach every file; minimal-API groups are local, and their line is evidence', async () => {
  const g = await graphOf({
    api: {
      'GlobalUsings.cs': 'global using Acme.Models;\n',
      'Models/Item.cs': 'namespace Acme.Models;\n\npublic record Item(int Id);\n',
      'Services/Maker.cs': 'namespace Acme.Services;\n\npublic class Maker\n{\n    public Item Make() => new Item(1);\n}\n',
      'Endpoints.cs':
        'public static class Endpoints\n{\n' +
        '    public static void Items(WebApplication app)\n    {\n        var group = app.MapGroup("/items");\n        group.MapGet("/{id}", () => "one");\n    }\n\n' +
        '    public static void Users(WebApplication app)\n    {\n        var group = app.MapGroup("/users");\n        group.MapGet("/{id}", () => "one");\n    }\n}\n',
    },
    web: { 'src/api.ts': 'export const getItem = (id: string) => fetch(`/items/${id}`);\n' },
  });
  const made = edge(g, 'api/Services/Maker.cs#Maker.Make', 'api/Models/Item.cs#Item', 'calls');
  assert.match(made.reason!, /imported from "Acme\.Models"/);
  assert.ok(made.evidence!.some((x) => x.file === 'api/GlobalUsings.cs' && x.line === 1), 'cites the global using where it is declared');
  const routes = g.nodes.filter((n) => n.id.startsWith('api/Endpoints.cs')).flatMap((n) => n.routes ?? []);
  assert.deepEqual(routes.sort(), ['GET /items/{id}', 'GET /users/{id}']);
  const http = edge(g, 'web/src/api.ts#getItem', 'api/Endpoints.cs', 'http');
  assert.ok(http.evidence!.some((x) => x.file === 'api/Endpoints.cs' && x.line === 5), 'cites the MapGroup line');
});

test('Rust: full paths in calls, and a use inside an inline module binds only there', async () => {
  const g = await graphOf({
    app: {
      'Cargo.toml': '[package]\nname = "app"\n',
      'src/lib.rs':
        'pub mod models;\npub mod other;\n\npub fn run() {\n    crate::models::Item::new();\n    models::helper();\n}\n\n' +
        'mod a {\n    use crate::models::Item;\n    pub fn f() { Item::new(); }\n}\n\nmod b {\n    use crate::other::Item;\n    pub fn g() { Item::new(); }\n}\n',
      'src/models.rs': 'pub struct Item;\nimpl Item { pub fn new() -> Self { Item } }\npub fn helper() {}\n\nmod tests {\n    use super::*;\n    fn t() { helper(); }\n}\n',
      'src/other.rs': 'pub struct Item;\nimpl Item { pub fn new() -> Self { Item } }\n',
    },
  });
  assert.match(edge(g, 'app/src/lib.rs#run', 'app/src/models.rs#Item.new', 'calls').reason!, /by its full path/);
  edge(g, 'app/src/lib.rs#run', 'app/src/models.rs#helper', 'calls');
  edge(g, 'app/src/lib.rs#a.f', 'app/src/models.rs#Item.new', 'calls');
  edge(g, 'app/src/lib.rs#b.g', 'app/src/other.rs#Item.new', 'calls');
  noEdge(g, 'app/src/lib.rs#a.f', 'app/src/other.rs#Item.new');
  // `use super::*` in an inline module is the file's own module.
  edge(g, 'app/src/models.rs#tests.t', 'app/src/models.rs#helper', 'calls');
});

test('Rust: use paths through crate, self, super and other crates; mod files; impl methods', async () => {
  const g = await graphOf({
    ws: {
      'core/Cargo.toml': '[package]\nname = "acme-core"\nversion = "0.1.0"\n',
      'core/src/lib.rs': 'pub mod model;\n\npub fn version() -> u32 { 1 }\n',
      'core/src/model.rs': 'pub struct Item { pub id: u64 }\n\nimpl Item {\n    pub fn new(id: u64) -> Self { Item { id } }\n}\n',
      'app/Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\nacme-core = { path = "../core" }\n',
      'app/src/main.rs': 'mod routes;\n\nfn main() {\n    routes::serve();\n}\n',
      'app/src/routes/mod.rs':
        'mod items;\n\nuse acme_core::model::Item;\nuse crate::routes::items::*;\n\n' +
        'pub fn serve() {\n    let it = Item::new(1);\n    show(it);\n}\n\npub fn ok() -> bool { true }\n',
      'app/src/routes/items.rs':
        'use super::ok;\nuse actix_web::get;\n\n' +
        'pub struct Handler;\n\npub trait Show { fn show(&self); }\n\nimpl Show for Handler {\n    fn show(&self) { self.log(); }\n}\n\nimpl Handler {\n    fn log(&self) {}\n}\n\n' +
        '#[get("/items/{id}")]\npub async fn show(it: crate::Item) { ok(); }\n',
    },
  });
  // A mod declaration pulls in the module's file, and `routes::serve()` calls through it.
  assert.match(edge(g, 'ws/core/src/lib.rs', 'ws/core/src/model.rs', 'imports').reason!, /imports "self::model"/);
  edge(g, 'ws/app/src/main.rs#main', 'ws/app/src/routes/mod.rs#serve', 'calls');
  assert.match(edge(g, 'ws/app/src/routes/items.rs#show', 'ws/app/src/routes/mod.rs#ok', 'calls').reason!, /imported from "super::ok"/);
  // Another crate of the workspace, by the name its Cargo.toml gives it.
  assert.match(edge(g, 'ws/app/src/routes/mod.rs#serve', 'ws/core/src/model.rs#Item.new', 'calls').reason!, /imported from "acme_core::model::Item"/);
  // A glob import from a child module.
  edge(g, 'ws/app/src/routes/mod.rs#serve', 'ws/app/src/routes/items.rs#show', 'calls');
  edge(g, 'ws/app/src/routes/items.rs#Handler.show', 'ws/app/src/routes/items.rs#Handler.log', 'calls');
  assert.deepEqual(node(g, 'ws/app/src/routes/items.rs#Handler').symbolKind, 'class');
  assert.deepEqual(node(g, 'ws/app/src/routes/items.rs#show').routes, ['GET /items/{id}']);
});

test('Rust: a use inside a function binds only there', async () => {
  const g = await graphOf({
    app: {
      'Cargo.toml': '[package]\nname = "app"\n',
      'src/lib.rs': 'mod a;\nmod b;\n\npub fn one() {\n    use crate::a::Item;\n    Item::make();\n}\n\npub fn two() {\n    use crate::b::Item;\n    Item::make();\n}\n',
      'src/a.rs': 'pub struct Item;\nimpl Item { pub fn make() {} }\n',
      'src/b.rs': 'pub struct Item;\nimpl Item { pub fn make() {} }\n',
    },
  });
  const one = edge(g, 'app/src/lib.rs#one', 'app/src/a.rs#Item.make', 'calls');
  assert.ok(one.evidence!.some((x) => x.source === 'import' && x.code === 'use crate::a::Item;'), 'the scoped use line is shown as code');
  edge(g, 'app/src/lib.rs#two', 'app/src/b.rs#Item.make', 'calls');
  noEdge(g, 'app/src/lib.rs#one', 'app/src/b.rs#Item.make');
});

test('C++: a namespace keeps same-named declarations apart', async () => {
  const g = await graphOf({
    app: {
      'src/shapes.h': 'namespace a { struct Foo { int x; }; }\nnamespace b { struct Foo { int y; }; }\n',
      'src/main.cpp':
        '#include "shapes.h"\n\nint useB() { auto f = new b::Foo(); return 0; }\n' +
        'namespace a {\nint useA() { Foo f; return 0; }\n}\nint vec() { std::vector<int> v; return 0; }\n',
    },
  });
  const [aFoo, bFoo] = ['app/src/shapes.h#Foo', 'app/src/shapes.h#Foo~2'];
  assert.equal(node(g, bFoo).symbolKind, 'class');
  edge(g, 'app/src/main.cpp#useB', bFoo, 'calls');
  noEdge(g, 'app/src/main.cpp#useB', aFoo);
  // Inside namespace a, a bare Foo is a::Foo.
  edge(g, 'app/src/main.cpp#useA', aFoo, 'type');
  noEdge(g, 'app/src/main.cpp#useA', bFoo);
});

test('Rust: an inline module keeps its declarations apart from another\'s', async () => {
  const g = await graphOf({
    app: {
      'Cargo.toml': '[package]\nname = "app"\n',
      'src/lib.rs':
        'mod a {\n    pub struct Item;\n    pub fn make() -> Item { Item }\n}\n\nmod b {\n    pub struct Item;\n    pub fn make() -> Item { Item }\n}\n\n' +
        'pub fn both() {\n    a::make();\n    b::Item;\n}\n',
    },
  });
  edge(g, 'app/src/lib.rs#b.make', 'app/src/lib.rs#b.Item');
  noEdge(g, 'app/src/lib.rs#b.make', 'app/src/lib.rs#a.Item');
  edge(g, 'app/src/lib.rs#both', 'app/src/lib.rs#a.make', 'calls');
  edge(g, 'app/src/lib.rs#both', 'app/src/lib.rs#b.Item');
});

test('Rust: src/main.rs beside src/lib.rs is its own crate; crate:: and super:: paths keep their qualifier', async () => {
  const g = await graphOf({
    app: {
      'Cargo.toml': '[package]\nname = "app"\n',
      'src/lib.rs': 'pub fn run() {}\npub fn helper() {}\n\nmod inner {\n    fn helper() {}\n    fn go() { super::helper(); }\n}\n',
      'src/main.rs': 'mod cli;\n\nfn run() {}\n\nfn main() {\n    crate::run();\n    app::run();\n}\n',
      'src/cli.rs': 'pub fn parse() { crate::run(); }\n',
    },
  });
  // The binary's crate:: is main.rs; the library is reached by its name.
  assert.match(edge(g, 'app/src/main.rs#main', 'app/src/main.rs#run', 'calls').reason!, /by its full path/);
  edge(g, 'app/src/main.rs#main', 'app/src/lib.rs#run', 'calls');
  edge(g, 'app/src/cli.rs#parse', 'app/src/main.rs#run', 'calls');
  noEdge(g, 'app/src/cli.rs#parse', 'app/src/lib.rs#run');
  // super::helper() in `mod inner` is the file's helper, not inner's own.
  edge(g, 'app/src/lib.rs#inner.go', 'app/src/lib.rs#helper', 'calls');
  noEdge(g, 'app/src/lib.rs#inner.go', 'app/src/lib.rs#inner.helper');
});

test('Rust: a module both the library and the binary declare, and a renamed dependency', async () => {
  const g = await graphOf({
    ws: {
      'acme-util/Cargo.toml': '[package]\nname = "acme-util"\n',
      'acme-util/src/lib.rs': 'pub fn go() {}\n',
      'app/Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\nutil = { package = "acme-util", path = "../acme-util" }\n',
      'app/src/lib.rs': 'pub mod common;\n',
      'app/src/main.rs': 'mod common;\nuse util::go;\n\nfn main() {\n    crate::common::run();\n    go();\n}\n',
      'app/src/common.rs': 'pub fn run() {}\n',
    },
  });
  edge(g, 'ws/app/src/main.rs#main', 'ws/app/src/common.rs#run', 'calls');
  assert.match(edge(g, 'ws/app/src/main.rs#main', 'ws/acme-util/src/lib.rs#go', 'calls').reason!, /imported from "util::go"/);
});

test('Rust: a binary in src/bin/<name>/main.rs is its own crate', async () => {
  const g = await graphOf({
    app: {
      'Cargo.toml': '[package]\nname = "app"\n',
      'src/lib.rs': 'pub fn run() {}\n',
      'src/bin/tool/main.rs': 'mod args;\n\nfn run() {}\n\nfn main() {\n    crate::run();\n    args::parse();\n}\n',
      'src/bin/tool/args.rs': 'pub fn parse() { crate::run(); }\n',
    },
  });
  edge(g, 'app/src/bin/tool/main.rs#main', 'app/src/bin/tool/main.rs#run', 'calls');
  edge(g, 'app/src/bin/tool/main.rs#main', 'app/src/bin/tool/args.rs#parse', 'calls');
  edge(g, 'app/src/bin/tool/args.rs#parse', 'app/src/bin/tool/main.rs#run', 'calls');
  noEdge(g, 'app/src/bin/tool/args.rs#parse', 'app/src/lib.rs#run');
});

test('Rust: a crate name two repositories share means the referring repository\'s crate', async () => {
  const crate = { 'common/Cargo.toml': '[package]\nname = "common"\n', 'common/src/lib.rs': 'pub fn hello() {}\n' };
  const app = { 'app/Cargo.toml': '[package]\nname = "app"\n', 'app/src/main.rs': 'use common::hello;\n\nfn main() { hello(); }\n' };
  const g = await graphOf({ first: crate, second: { ...crate, ...app }, third: app });
  assert.equal(edge(g, 'second/app/src/main.rs#main', 'second/common/src/lib.rs#hello', 'calls').basis, 'evidenced');
  noEdge(g, 'second/app/src/main.rs#main', 'first/common/src/lib.rs#hello');
  // Only in another repository: linked, but as a guess.
  assert.match(edge(g, 'third/app/src/main.rs#main', 'first/common/src/lib.rs#hello', 'calls').reason!, /crate common isn't in this repository/);
});

test('C: includes make a header\'s declarations visible, directly or through another header', async () => {
  const g = await graphOf({
    lib: {
      'include/acme/item.h': '#ifndef ITEM_H\n#define ITEM_H\ntypedef struct { int id; } item_t;\nitem_t make_item(int id);\n#endif\n',
      'include/acme/acme.h': '#include "item.h"\nint acme_version(void);\n',
      'src/item.c': '#include "acme/item.h"\n\nitem_t make_item(int id) { item_t it = { id }; return it; }\n',
      'src/main.c':
        '#include <stdio.h>\n#include <config.h>\n#include "acme/acme.h"\n\nstatic int helper(void) { return 1; }\n\n' +
        'int main(void) {\n  item_t it = make_item(helper());\n  printf("%d %d", acme_version(), VERSION);\n  return 0;\n}\n',
      'src/config.h': 'typedef int VERSION;\n',
    },
  });
  // Found under include/, a usual include folder but not one the build was read for: a guess. Then item.h through acme.h.
  const version = edge(g, 'lib/src/main.c#main', 'lib/include/acme/acme.h#acme_version', 'calls');
  assert.equal(version.basis, 'inferred');
  assert.match(version.reason!, /found "acme\/acme\.h" at include\/acme\/acme\.h; include and load paths aren't read/);
  edge(g, 'lib/src/main.c#main', 'lib/include/acme/item.h#make_item', 'calls');
  edge(g, 'lib/src/main.c#main', 'lib/include/acme/item.h#item_t', 'type');
  edge(g, 'lib/src/main.c#main', 'lib/src/main.c#helper', 'calls');
  // `#include <…>` isn't looked for beside the file, so a header there is only a guess.
  assert.equal(edge(g, 'lib/src/main.c#main', 'lib/src/config.h#VERSION', 'references').basis, 'inferred');
  // An include beside the including file is certain.
  assert.equal(edge(g, 'lib/include/acme/acme.h', 'lib/include/acme/item.h', 'imports').basis, 'evidenced');
  assert.equal(node(g, 'lib/src/main.c#helper').exported, false);
});

test('C++: classes, out-of-line methods, this-> calls, and a header that is C++ by its syntax', async () => {
  const g = await graphOf({
    app: {
      'src/service.h': '#pragma once\nnamespace acme {\nclass Service {\n public:\n  int get(int id);\n private:\n  int log();\n};\n}\n',
      'src/service.cpp': '#include "service.h"\n\nnamespace acme {\nint Service::get(int id) { return this->log() + id; }\nint Service::log() { return 0; }\n}\n',
      'src/main.cpp': '#include "service.h"\n\nint main() {\n  auto s = new acme::Service();\n  return s->get(1);\n}\n',
    },
  });
  assert.equal(g.repos[0].languages?.cpp, 3);
  edge(g, 'app/src/service.cpp#Service.get', 'app/src/service.cpp#Service.log', 'calls');
  edge(g, 'app/src/main.cpp#main', 'app/src/service.h#Service', 'calls');
  assert.equal(node(g, 'app/src/service.h#Service.get').symbolKind, 'function');
});

test('Ruby: requires, and constants found across the repository as Rails autoloads them', async () => {
  const g = await graphOf({
    shop: {
      'app/models/user.rb': 'class User < ApplicationRecord\n  def self.active\n    where(active: true)\n  end\nend\n',
      'app/models/application_record.rb': 'class ApplicationRecord\nend\n',
      'app/policies/admin/policy.rb': 'module Admin\n  class Policy\n    def initialize(user); end\n  end\nend\n',
      'app/policies/policy.rb': 'class Policy\nend\n',
      'app/services/reports/audit.rb': 'module Reports\n  class Audit\n  end\nend\n',
      'app/controllers/admin/users_controller.rb':
        'module Admin\n  class UsersController\n    def index\n      users = User.active\n      Policy.new(users)\n      helper\n    end\n\n    private\n\n    def helper; Audit.new; end\n  end\nend\n',
      'lib/tasks/report.rb': 'require_relative "../format"\nrequire_relative "helpers"\nrequire "json"\n\ndef report\n  Format.table\nend\n',
      'lib/tasks/helpers.rb': 'def shout(s) = s.upcase\n',
      'lib/format.rb': 'module Format\n  def self.table; end\nend\n',
    },
  });
  assert.equal(g.repos[0].languages?.ruby, 9);
  const users = 'shop/app/controllers/admin/users_controller.rb#Admin::UsersController';
  assert.match(edge(g, `${users}.index`, 'shop/app/models/user.rb#User.active', 'calls').reason!, /Ruby constants are global/);
  // Inside module Admin, Policy is Admin::Policy before the top-level one, as Ruby looks it up.
  const policy = edge(g, `${users}.index`, 'shop/app/policies/admin/policy.rb#Admin::Policy', 'calls');
  assert.equal(policy.basis, 'evidenced');
  assert.match(policy.reason!, /declared in Admin, which the code is inside/);
  noEdge(g, `${users}.index`, 'shop/app/policies/policy.rb#Policy');
  // Found only by the last part of its name elsewhere: a guess.
  const audit = edge(g, `${users}.helper`, 'shop/app/services/reports/audit.rb#Reports::Audit', 'calls');
  assert.equal(audit.basis, 'inferred');
  assert.match(audit.reason!, /last part of the constant name/);
  edge(g, `${users}.index`, `${users}.helper`, 'calls');
  edge(g, 'shop/app/models/user.rb#User', 'shop/app/models/application_record.rb#ApplicationRecord', 'type');
  assert.match(edge(g, 'shop/lib/tasks/report.rb#report', 'shop/lib/format.rb#Format.table', 'calls').reason!, /Ruby constants/);
  // A require whose names aren't used still connects the files.
  assert.match(edge(g, 'shop/lib/tasks/report.rb', 'shop/lib/tasks/helpers.rb', 'imports').reason!, /imports "\.\/helpers"/);
});

test('Swift: files of one module see each other; another target comes in through import', async () => {
  const g = await graphOf({
    pkg: {
      'Sources/Models/Item.swift': 'public struct Item {\n  public let id: Int\n}\n',
      'Sources/App/Store.swift': 'import Models\n\nfinal class Store {\n  func load() -> Item { Item(id: 1) }\n}\n',
      'Sources/App/main.swift': 'let store = Store()\nprint(store.load())\n',
      'Sources/App/Store+Log.swift': 'extension Store {\n  func log() { self.load() }\n}\n',
    },
  });
  assert.match(edge(g, 'pkg/Sources/App/main.swift#store', 'pkg/Sources/App/Store.swift#Store', 'calls').reason!, /Swift module App/);
  assert.match(edge(g, 'pkg/Sources/App/Store.swift#Store.load', 'pkg/Sources/Models/Item.swift#Item', 'calls').reason!, /imported from "Models"/);
  // self.load() in an extension in another file reaches the extended type's method.
  edge(g, 'pkg/Sources/App/Store+Log.swift#Store.log', 'pkg/Sources/App/Store.swift#Store.load', 'calls');
  noEdge(g, 'pkg/Sources/Models/Item.swift#Item', 'pkg/Sources/App/Store.swift#Store');
});

test('Swift: a member declared in an extension in another file', async () => {
  const g = await graphOf({
    pkg: {
      'Sources/App/Thing.swift': 'struct Thing {}\n',
      'Sources/App/Thing+Make.swift': 'extension Thing {\n  static func make() -> Thing { Thing() }\n}\n',
      'Sources/App/main.swift': 'let made = Thing.make()\n',
    },
  });
  edge(g, 'pkg/Sources/App/main.swift#made', 'pkg/Sources/App/Thing+Make.swift#Thing.make', 'calls');
});

test('Swift: a module found only in another repository is a guess', async () => {
  const g = await graphOf({
    lib: { 'Sources/Models/Item.swift': 'public struct Item {}\n' },
    app: { 'Sources/App/Use.swift': 'import Models\n\nfunc use() -> Item { Item() }\n' },
  });
  const e = edge(g, 'app/Sources/App/Use.swift#use', 'lib/Sources/Models/Item.swift#Item', 'calls');
  assert.equal(e.basis, 'inferred');
  assert.match(e.reason!, /module Models isn't in this repository/);
});

test('every new grammar loads and parses, Ruby included (its scanner needs iswupper)', async () => {
  const samples: [string, string, string][] = [
    ['A.java', 'class A { void f() {} }', 'A.f'],
    ['a.kt', 'class A {\n  fun f() {}\n}\n', 'A.f'],
    ['A.cs', 'class A { void F() {} }', 'A.F'],
    ['a.rs', 'struct A; impl A { fn f(&self) {} }', 'A.f'],
    ['a.c', 'int f(void) { return 0; }', 'f'],
    ['a.cc', 'struct A { void f() {} };', 'A.f'],
    ['a.rb', 'class A\n  def f; end\nend\n', 'A.f'],
    ['a.swift', 'class A { func f() {} }', 'A.f'],
  ];
  for (const [file, text, symbol] of samples) {
    const parsed = await parseFile(file, text);
    assert.ok(parsed?.symbols.some((s) => s.name === symbol), `${file}: expected ${symbol}, got ${parsed?.symbols.map((s) => s.name)}`);
    assert.ok(!parsed!.partial, `${file} parsed with errors`);
  }
  assert.equal((await parseFile('x.h', 'int f(void);'))?.lang, 'c');
  assert.equal((await parseFile('x.h', 'namespace a { class B {}; }'))?.lang, 'cpp');
  assert.equal((await parseFile('x.inl', 'inline int f() { return 1; }'))?.lang, 'cpp');
  // Test files by name, acronyms included; words that merely end in "test" aren't.
  for (const p of ['src/URLTest.java', 'HTTPTests.cs', 'ATest.kt', 'ItemTests.swift', 'spec/user_spec.rb']) assert.ok(TEST_PATH.test(p), p);
  for (const p of ['src/Contest.java', 'src/Latest.kt', 'src/Test.java']) assert.ok(!TEST_PATH.test(p), p);
});
