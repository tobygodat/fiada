// A small two-repository graph for the map's unit tests: a web app whose
// page calls an API client that requests a backend route, which reads a model.

import type { Graph, GraphEdge, GraphNode } from '@fiada/shared';

export function fixtureGraph(): Graph {
  const nodes: GraphNode[] = [];
  const add = (id: string, kind: GraphNode['kind'], parent: string, loc = 20) => {
    const repo = id.split('/')[0];
    const name = id.includes('#') ? id.slice(id.indexOf('#') + 1) : id.slice(id.lastIndexOf('/') + 1);
    const path = id.includes('/') ? id.slice(repo.length + 1).split('#')[0] : undefined;
    nodes.push({ id, kind, name, parent, repo, path, loc, layer: { id: 'ui', confidence: 1, source: 'fact', evidence: [] }, domain: { id: 'items', confidence: 1, source: 'seed', evidence: [] } });
  };
  add('web', 'repo', 'root');
  add('web/src', 'folder', 'web');
  add('web/src/pages', 'folder', 'web/src');
  add('web/src/pages/items.tsx', 'file', 'web/src/pages');
  add('web/src/pages/items.tsx#ItemsPage', 'symbol', 'web/src/pages/items.tsx', 40);
  add('web/src/pages/items.tsx#useItems', 'symbol', 'web/src/pages/items.tsx', 12);
  add('web/src/pages/about.tsx', 'file', 'web/src/pages', 30);
  add('web/src/client', 'folder', 'web/src');
  add('web/src/client/api.ts', 'file', 'web/src/client');
  add('web/src/client/api.ts#ItemsService', 'symbol', 'web/src/client/api.ts', 60);
  add('web/src/client/api.ts#UsersService', 'symbol', 'web/src/client/api.ts', 50);
  add('api', 'repo', 'root');
  add('api/app', 'folder', 'api');
  add('api/app/routes', 'folder', 'api/app');
  add('api/app/routes/items.py', 'file', 'api/app/routes');
  add('api/app/routes/items.py#read_items', 'symbol', 'api/app/routes/items.py', 25);
  add('api/app/routes/items.py#create_item', 'symbol', 'api/app/routes/items.py', 25);
  add('api/app/models.py', 'file', 'api/app');
  add('api/app/models.py#Item', 'symbol', 'api/app/models.py', 15);
  add('api/app/models.py#User', 'symbol', 'api/app/models.py', 15);
  const edges: GraphEdge[] = [
    { from: 'web/src/pages/items.tsx#ItemsPage', to: 'web/src/pages/items.tsx#useItems', kind: 'calls' },
    { from: 'web/src/pages/items.tsx#useItems', to: 'web/src/client/api.ts#ItemsService', kind: 'calls' },
    { from: 'web/src/pages/about.tsx', to: 'web/src/client/api.ts', kind: 'imports' },
    { from: 'web/src/client/api.ts#ItemsService', to: 'api/app/routes/items.py#read_items', kind: 'http', detail: 'GET /items/' },
    // Matched on the route's tail only, so a guess.
    {
      from: 'web/src/client/api.ts#ItemsService',
      to: 'api/app/routes/items.py#create_item',
      kind: 'http',
      detail: 'POST /items/',
      basis: 'inferred',
      confidence: 0.6,
      reason: "request matched the route's tail; the /api prefix wasn't found",
    },
    { from: 'api/app/routes/items.py#read_items', to: 'api/app/models.py#Item', kind: 'references' },
    { from: 'api/app/routes/items.py#create_item', to: 'api/app/models.py#Item', kind: 'calls' },
    { from: 'api/app/models.py#Item', to: 'api/app/models.py#User', kind: 'type' },
    // A file-level edge into a symbol of the same file: lifts onto its own ancestor when the file is open.
    { from: 'api/app/models.py', to: 'api/app/models.py#User', kind: 'references' },
  ];
  return {
    version: 1,
    generatedAt: '2026-09-27T00:00:00Z',
    repos: [
      { id: 'web', name: 'web', source: '/web', kind: 'local', status: 'ready' },
      { id: 'api', name: 'api', source: '/api', kind: 'local', status: 'ready' },
    ],
    nodes,
    edges,
    layers: [{ id: 'ui', name: 'UI' }],
    domains: [{ id: 'items', name: 'Items' }],
  };
}
