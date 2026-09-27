// The pipeline: parsed repos → linked edges → facts → node tree (buildBase),
// then classification against the project's grouping (classifyGraph). The two
// halves are separate so a grouping change reclassifies without re-linking.

import path from 'node:path';
import type { Graph, GraphEdge, GraphNode, Grouping, RepoInfo } from '@strata/shared';
import { classify, type Strategies } from './classify/index.ts';
import { detectFacts } from './facts.ts';
import { fileId, link, symbolIds } from './link.ts';
import type { ParsedRepo } from './model.ts';
import { TEST_PATH } from './sources.ts';

/** The graph before classification. */
export interface BaseGraph {
  repos: RepoInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildBase(repos: ParsedRepo[]): BaseGraph {
  const { edges, routes, pages, externalImports } = link(repos);

  // Routes show their full path when every mount above them was found.
  const routesByNode = new Map<string, string[]>();
  for (const r of routes) {
    const list = routesByNode.get(r.node) ?? [];
    const label = `${r.method} ${r.fullPath ?? (r.path || '/')}`;
    const bare = (l: string) => l.replace(/(.)\/$/, '$1');
    if (!list.some((l) => bare(l) === bare(label))) list.push(label);
    routesByNode.set(r.node, list);
  }
  const pagesByNode = new Map<string, string[]>();
  for (const p of pages) {
    const list = pagesByNode.get(p.node) ?? [];
    if (!list.includes(p.path)) list.push(p.path);
    pagesByNode.set(p.node, list);
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
      const ids = symbolIds(id, f);
      const facts = detectFacts({
        repo,
        file: f,
        externalImports: externalImports.get(id) ?? [],
        routes: [routesByNode.get(id), ...ids.map((s) => routesByNode.get(s))],
        pages: [pagesByNode.get(id), ...ids.map((s) => pagesByNode.get(s))],
        test: TEST_PATH.test(f.path),
      });
      nodes.push({
        id,
        kind: 'file',
        name: path.posix.basename(f.path),
        parent: folderNode.get(d === '.' ? '' : d) ?? rid,
        repo: rid,
        path: f.path,
        lang: f.lang,
        loc: f.loc,
        facts: facts.file.length ? facts.file : undefined,
        routes: routesByNode.get(id),
      });
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
          facts: facts.symbols[i].length ? facts.symbols[i] : undefined,
          routes: routesByNode.get(ids[i]),
        });
      });
    }
  }

  return { repos: repos.map((r) => r.info), nodes, edges };
}

/** Places every file and symbol in one of the project's layers and a domain. */
export function classifyGraph(base: BaseGraph, grouping: Grouping, strategies?: Strategies): Graph {
  const { layers, domains, domainList } = classify(base.nodes, base.edges, grouping, strategies);
  const nodes = base.nodes.map((n) => (n.kind === 'file' || n.kind === 'symbol' ? { ...n, layer: layers.get(n.id), domain: domains.get(n.id) } : n));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repos: base.repos,
    nodes,
    edges: base.edges,
    layers: grouping.layers.map(({ id, name, rank }) => ({ id, name, ...(rank == null ? {} : { rank }) })),
    domains: domainList,
    preset: grouping.preset,
  };
}

export function buildGraph(repos: ParsedRepo[], grouping: Grouping, strategies?: Strategies): Graph {
  return classifyGraph(buildBase(repos), grouping, strategies);
}
