// The pipeline: parsed repos → linked edges → classification → graph.

import path from 'node:path';
import type { Graph, GraphNode } from '@strata/shared';
import { classifyAll, defaultDomainChain, defaultLayerChain, type DomainClassifier, type FileContext, type LayerClassifier } from './classify/index.ts';
import { fileId, link, symbolIds } from './link.ts';
import type { ParsedRepo } from './model.ts';

const UI_FRAMEWORKS = /^(react|react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|react-native|solid-js|preact)$/;

export interface BuildOptions {
  layerChain?: LayerClassifier[];
  domainChain?: DomainClassifier[];
}

export function buildGraph(repos: ParsedRepo[], opts: BuildOptions = {}): Graph {
  const layerChain = opts.layerChain ?? defaultLayerChain();
  const domainChain = opts.domainChain ?? defaultDomainChain();
  const { edges, routes, externalImports } = link(repos);

  // File-to-file call structure, for classifiers that reason about neighbours.
  const fileOf = (id: string) => id.split('#')[0];
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  for (const e of edges) {
    const a = fileOf(e.from);
    const b = fileOf(e.to);
    if (a === b) continue;
    if (!callers.has(b)) callers.set(b, new Set());
    if (!callees.has(a)) callees.set(a, new Set());
    callers.get(b)!.add(a);
    callees.get(a)!.add(b);
  }

  const contexts: FileContext[] = [];
  for (const repo of repos) {
    const uiDirs = repo.packages.filter((p) => p.deps.some((d) => UI_FRAMEWORKS.test(d))).map((p) => p.dir);
    for (const file of repo.files) {
      const id = fileId(repo.info.id, file.path);
      const frontend = file.lang !== 'python' && uiDirs.some((d) => d === '' || file.path.startsWith(d + '/'));
      contexts.push({
        repo,
        file,
        id,
        externalImports: externalImports.get(id) ?? [],
        frontend,
        callers: [...(callers.get(id) ?? [])],
        callees: [...(callees.get(id) ?? [])],
      });
    }
  }
  const classes = classifyAll(contexts, layerChain, domainChain);

  const routesByNode = new Map<string, string[]>();
  for (const r of routes) {
    const list = routesByNode.get(r.node) ?? [];
    list.push(`${r.method} ${r.path}`);
    routesByNode.set(r.node, list);
  }

  const nodes: GraphNode[] = [];
  for (const repo of repos) {
    const rid = repo.info.id;
    nodes.push({ id: rid, kind: 'repo', name: repo.info.name, parent: 'root', repo: rid });

    // Folders, with single-child chains collapsed ("src/main/java" is one node).
    const dirs = new Map<string, { subdirs: Set<string>; files: number }>();
    const dir = (d: string) => {
      let e = dirs.get(d);
      if (!e) dirs.set(d, (e = { subdirs: new Set(), files: 0 }));
      return e;
    };
    dir('');
    for (const f of repo.files) {
      let d = path.posix.dirname(f.path);
      if (d === '.') d = '';
      dir(d).files++;
      while (d) {
        const parent = path.posix.dirname(d) === '.' ? '' : path.posix.dirname(d);
        dir(parent).subdirs.add(d);
        d = parent;
      }
    }
    const folderNode = new Map<string, string>(); // dir → emitted node id
    folderNode.set('', rid);
    const emit = (d: string, parentId: string, parentDir: string) => {
      let end = d;
      for (;;) {
        const e = dirs.get(end)!;
        if (e.files || e.subdirs.size !== 1) break;
        end = [...e.subdirs][0];
      }
      const id = `${rid}/${end}`;
      nodes.push({ id, kind: 'folder', name: parentDir ? end.slice(parentDir.length + 1) : end, parent: parentId, repo: rid, path: end });
      for (let x = end; ; x = path.posix.dirname(x)) {
        folderNode.set(x, id);
        if (x === d || x === '.' || !x) break;
      }
      for (const sub of [...dirs.get(end)!.subdirs].sort()) emit(sub, id, end);
    };
    for (const sub of [...dirs.get('')!.subdirs].sort()) emit(sub, rid, '');

    for (const f of repo.files) {
      const id = fileId(rid, f.path);
      const d = path.posix.dirname(f.path);
      const c = classes.get(id)!;
      nodes.push({
        id,
        kind: 'file',
        name: path.posix.basename(f.path),
        parent: folderNode.get(d === '.' ? '' : d) ?? rid,
        repo: rid,
        path: f.path,
        lang: f.lang,
        loc: f.loc,
        layer: c.layer,
        domain: c.domain,
        routes: routesByNode.get(id),
      });
      const ids = symbolIds(id, f);
      f.symbols.forEach((s, i) => {
        nodes.push({
          id: ids[i],
          kind: 'symbol',
          name: s.name === 'default' ? `${path.posix.basename(f.path).replace(/\.[^.]+$/, '')} (default)` : s.name,
          parent: id,
          repo: rid,
          path: f.path,
          lang: f.lang,
          symbolKind: s.kind,
          exported: s.exported,
          loc: s.lines[1] - s.lines[0] + 1,
          lines: s.lines,
          layer: c.symbols[i].layer,
          domain: c.symbols[i].domain,
          routes: routesByNode.get(ids[i]),
        });
      });
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repos: repos.map((r) => r.info),
    nodes,
    edges,
    classifiers: { layer: layerChain.map((c) => c.name), domain: domainChain.map((c) => c.name) },
  };
}
