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
import { loadRepo } from './sources.ts';

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
  assert.match(edge(g, `${dir}/shop/ItemController.java#ItemController.get`, `${dir}/util/Strings.java#Strings`, 'calls').reason!, /imported from "com\.acme\.util"/);
  // this.save() is the sibling method.
  edge(g, `${dir}/shop/ItemController.java#ItemController.create`, `${dir}/shop/ItemController.java#ItemController.save`, 'calls');

  assert.deepEqual(node(g, `${dir}/shop/ItemController.java#ItemController.get`).routes, ['GET /api/items/{id}']);
  assert.deepEqual(node(g, `${dir}/shop/ItemController.java#ItemController.create`).routes, ['POST /api/items']);
  const http = edge(g, 'web/src/api.ts#getItem', `${dir}/shop/ItemController.java#ItemController.get`, 'http');
  assert.equal(http.detail, 'GET /api/items/{id}');
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

test('C#: namespaces and their parents, usings, controller and minimal-API routes', async () => {
  const g = await graphOf({
    api: {
      'Models/Item.cs': 'namespace Acme.Models;\n\npublic record Item(int Id);\n',
      'Core/Clock.cs': 'namespace Acme;\n\npublic static class Clock { public static int Now() => 0; }\n',
      'Controllers/ItemsController.cs':
        'using Acme.Models;\nusing Microsoft.AspNetCore.Mvc;\n\nnamespace Acme.Controllers;\n\n' +
        '[ApiController]\n[Route("api/[controller]")]\npublic class ItemsController : ControllerBase\n{\n' +
        '    [HttpGet("{id}")]\n    public Item Get(int id) { Clock.Now(); return new Item(id); }\n}\n',
      'Program.cs': 'var app = WebApplication.Create();\nvar api = app.MapGroup("/v2");\napi.MapGet("/health", () => "ok");\napp.Run();\n',
    },
  });
  assert.match(edge(g, 'api/Controllers/ItemsController.cs#ItemsController.Get', 'api/Models/Item.cs#Item', 'calls').reason!, /imported from "Acme\.Models"/);
  // Acme.Controllers sees Acme without a using.
  assert.match(edge(g, 'api/Controllers/ItemsController.cs#ItemsController.Get', 'api/Core/Clock.cs#Clock', 'calls').reason!, /namespace Acme\b/);
  assert.deepEqual(node(g, 'api/Controllers/ItemsController.cs#ItemsController.Get').routes, ['GET /api/Items/{id}']);
  assert.deepEqual(node(g, 'api/Program.cs').routes, ['GET /v2/health']);
  assert.ok(g.edges.every((e) => !e.to.startsWith('ns:')), 'namespaces reach edges as their folders');
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
  // A mod declaration pulls in the module's file.
  assert.match(edge(g, 'ws/app/src/main.rs', 'ws/app/src/routes/mod.rs', 'imports').reason!, /imports "self::routes"/);
  assert.match(edge(g, 'ws/app/src/routes/items.rs#show', 'ws/app/src/routes/mod.rs#ok', 'calls').reason!, /imported from "super::ok"/);
  // Another crate of the workspace, by the name its Cargo.toml gives it.
  assert.match(edge(g, 'ws/app/src/routes/mod.rs#serve', 'ws/core/src/model.rs#Item', 'calls').reason!, /imported from "acme_core::model::Item"/);
  // A glob import from a child module.
  edge(g, 'ws/app/src/routes/mod.rs#serve', 'ws/app/src/routes/items.rs#show', 'calls');
  edge(g, 'ws/app/src/routes/items.rs#Handler.show', 'ws/app/src/routes/items.rs#Handler.log', 'calls');
  assert.deepEqual(node(g, 'ws/app/src/routes/items.rs#Handler').symbolKind, 'class');
  assert.deepEqual(node(g, 'ws/app/src/routes/items.rs#show').routes, ['GET /items/{id}']);
});

test('C: includes make a header\'s declarations visible, directly or through another header', async () => {
  const g = await graphOf({
    lib: {
      'include/acme/item.h': '#ifndef ITEM_H\n#define ITEM_H\ntypedef struct { int id; } item_t;\nitem_t make_item(int id);\n#endif\n',
      'include/acme/acme.h': '#include "item.h"\nint acme_version(void);\n',
      'src/item.c': '#include "acme/item.h"\n\nitem_t make_item(int id) { item_t it = { id }; return it; }\n',
      'src/main.c':
        '#include <stdio.h>\n#include "acme/acme.h"\n\nstatic int helper(void) { return 1; }\n\n' +
        'int main(void) {\n  item_t it = make_item(helper());\n  printf("%d", acme_version());\n  return 0;\n}\n',
    },
  });
  // Found under include/, then item.h through acme.h.
  assert.match(edge(g, 'lib/src/main.c#main', 'lib/include/acme/acme.h#acme_version', 'calls').reason!, /imported from "acme\/acme\.h"/);
  edge(g, 'lib/src/main.c#main', 'lib/include/acme/item.h#make_item', 'calls');
  edge(g, 'lib/src/main.c#main', 'lib/include/acme/item.h#item_t', 'type');
  edge(g, 'lib/src/main.c#main', 'lib/src/main.c#helper', 'calls');
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
      'app/controllers/admin/users_controller.rb':
        'module Admin\n  class UsersController\n    def index\n      users = User.active\n      Policy.new(users)\n      helper\n    end\n\n    private\n\n    def helper; end\n  end\nend\n',
      'lib/tasks/report.rb': 'require_relative "../format"\nrequire_relative "helpers"\nrequire "json"\n\ndef report\n  Format.table\nend\n',
      'lib/tasks/helpers.rb': 'def shout(s) = s.upcase\n',
      'lib/format.rb': 'module Format\n  def self.table; end\nend\n',
    },
  });
  assert.equal(g.repos[0].languages?.ruby, 7);
  const users = 'shop/app/controllers/admin/users_controller.rb#Admin::UsersController';
  assert.match(edge(g, `${users}.index`, 'shop/app/models/user.rb#User', 'calls').reason!, /Ruby constants are global/);
  // Inside module Admin, Policy is Admin::Policy: by the last part of its name, so a guess.
  const policy = edge(g, `${users}.index`, 'shop/app/policies/admin/policy.rb#Admin::Policy', 'calls');
  assert.equal(policy.basis, 'inferred');
  assert.match(policy.reason!, /last part of the constant name/);
  edge(g, `${users}.index`, `${users}.helper`, 'calls');
  edge(g, 'shop/app/models/user.rb#User', 'shop/app/models/application_record.rb#ApplicationRecord', 'type');
  assert.match(edge(g, 'shop/lib/tasks/report.rb#report', 'shop/lib/format.rb#Format', 'calls').reason!, /Ruby constants/);
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
  // self.load() in an extension in another file points at the type it extends.
  edge(g, 'pkg/Sources/App/Store+Log.swift#Store.log', 'pkg/Sources/App/Store.swift#Store', 'calls');
  noEdge(g, 'pkg/Sources/Models/Item.swift#Item', 'pkg/Sources/App/Store.swift#Store');
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
});
