// Builds the two hierarchies the map can show over the same graph:
//   code      repository → folder → file → symbol   (structural truth, read-only)
//   function  domain → layer → symbol               (the theoretical grouping)
// Symbols keep their graph ids in both, so edges resolve the same way.

import { UNLAYERED, UNSORTED_DOMAIN, type Graph, type GraphNode } from '@strata/shared';

export type View = 'code' | 'function';

export type TKind = 'root' | 'repo' | 'folder' | 'file' | 'symbol' | 'domain' | 'layer';

export interface TNode {
  id: string;
  kind: TKind;
  name: string;
  parent: string | null;
  children: TNode[];
  depth: number;
  /** Home repository; empty for domains and layers, which can span several. */
  repo: string;
  /** The underlying graph node, for repos, folders, files and symbols. */
  data?: GraphNode;
  /** Layer id: the node's own, or for folders and repos the one most of their code is in. */
  layer?: string;
  /** Leaf size in layout units. */
  size: number;
  /** Number of symbols underneath (or 1 for a symbol). */
  symbols: number;
}

export interface Tree {
  view: View;
  root: TNode;
  nodes: Map<string, TNode>;
}

const leafSize = (n: GraphNode) => {
  const loc = Math.max(3, Math.min(n.loc ?? 10, 600));
  return n.kind === 'symbol' ? Math.sqrt(loc) : Math.sqrt(loc) * 0.6 + 1;
};

function finish(root: TNode, nodes: Map<string, TNode>, view: View): Tree {
  const walk = (n: TNode, depth: number): number => {
    n.depth = depth;
    if (!n.children.length) return (n.symbols = n.kind === 'symbol' ? 1 : 0);
    let s = 0;
    for (const c of n.children) s += walk(c, depth + 1);
    return (n.symbols = s);
  };
  walk(root, -1);
  return { view, root, nodes };
}

const mkRoot = (): TNode => ({ id: 'root', kind: 'root', name: 'workspace', parent: null, children: [], depth: -1, repo: '', size: 0, symbols: 0 });

export function buildCodeTree(graph: Graph): Tree {
  const root = mkRoot();
  const nodes = new Map<string, TNode>([['root', root]]);
  for (const g of graph.nodes) {
    nodes.set(g.id, {
      id: g.id,
      kind: g.kind,
      name: g.name,
      parent: g.parent,
      children: [],
      depth: 0,
      repo: g.repo,
      data: g,
      layer: g.layer?.id,
      size: leafSize(g),
      symbols: 0,
    });
  }
  for (const n of nodes.values()) if (n.parent) nodes.get(n.parent)?.children.push(n);
  const tree = finish(root, nodes, 'code');
  dominantLayers(root);
  return tree;
}

/** Folders and repos take the layer most of their files have, so "color by layer" reads at every altitude. */
function dominantLayers(n: TNode): Map<string, number> {
  const tally = new Map<string, number>();
  if (n.kind === 'file' && n.layer) tally.set(n.layer, Math.max(1, n.data?.loc ?? 1));
  else for (const c of n.children) for (const [l, v] of dominantLayers(c)) tally.set(l, (tally.get(l) ?? 0) + v);
  if (n.kind === 'folder' || n.kind === 'repo') {
    const top = [...tally].filter(([l]) => l !== UNLAYERED).sort((a, b) => b[1] - a[1])[0];
    n.layer = top?.[0];
  }
  return tally;
}

export function buildFunctionTree(graph: Graph): Tree {
  const root = mkRoot();
  const nodes = new Map<string, TNode>([['root', root]]);
  const hasSymbols = new Set(graph.nodes.filter((n) => n.kind === 'symbol').map((n) => n.parent));

  const layerName = new Map([...graph.layers.map((l) => [l.id, l.name] as const), [UNLAYERED, 'Unlayered']]);
  const domainName = new Map(graph.domains.map((d) => [d.id, d.name]));
  const group = (id: string, name: string, kind: 'domain' | 'layer', parent: TNode, layer?: string) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, name, parent: parent.id, children: [], depth: 0, repo: '', size: 0, symbols: 0, layer };
      nodes.set(id, n);
      parent.children.push(n);
    }
    return n;
  };

  for (const g of graph.nodes) {
    // Symbols carry the grouping; files only appear when they have no symbols of their own.
    if (g.kind !== 'symbol' && !(g.kind === 'file' && !hasSymbols.has(g.id))) continue;
    const domain = g.domain?.id ?? UNSORTED_DOMAIN;
    const layer = g.layer?.id ?? UNLAYERED;
    const D = group(`domain:${domain}`, domainName.get(domain) ?? domain, 'domain', root);
    const L = group(`${D.id}/${layer}`, layerName.get(layer) ?? layer, 'layer', D, layer);
    const leaf: TNode = { id: g.id, kind: g.kind, name: g.name, parent: L.id, children: [], depth: 0, repo: g.repo, data: g, layer, size: leafSize(g), symbols: 0 };
    nodes.set(g.id, leaf);
    L.children.push(leaf);
  }

  // Domains in the order the graph lists them (Shared and Unsorted last); layers
  // in the project's order, Unlayered last.
  const domainOrder = new Map(graph.domains.map((d, i) => [`domain:${d.id}`, i]));
  const layerOrder = new Map(graph.layers.map((l, i) => [l.id, i]));
  const at = (m: Map<string, number>, k: string | undefined) => m.get(k ?? '') ?? 1e6;
  root.children.sort((a, b) => at(domainOrder, a.id) - at(domainOrder, b.id));
  for (const D of root.children) D.children.sort((a, b) => at(layerOrder, a.layer) - at(layerOrder, b.layer));
  return finish(root, nodes, 'function');
}

export function ancestors(tree: Tree, id: string): TNode[] {
  const out: TNode[] = [];
  let n = tree.nodes.get(id);
  while (n && n.id !== 'root') {
    out.unshift(n);
    n = n.parent ? tree.nodes.get(n.parent) : undefined;
  }
  return out;
}

/** Where a graph node lives in this tree: itself, or the nearest ancestor present. */
export function locate(tree: Tree, graphIndex: Map<string, GraphNode>, id: string): string | null {
  let cur: string | undefined = id;
  while (cur) {
    if (tree.nodes.has(cur)) return cur;
    cur = graphIndex.get(cur)?.parent;
  }
  return null;
}
