// HTTP API the map talks to. Binds to localhost: importing a local path reads
// that directory, so this is a single-user development tool, not a service.

import './env.ts';
import Fastify from 'fastify';
import type { LayerPreset } from '@strata/shared';
import { GroupingError, PRESETS } from './classify/index.ts';
import { checkProjectId, createStore } from './store.ts';
import { STRATA_HOME, Workspace } from './workspace.ts';

const PORT = Number(process.env.PORT ?? 4178);
const HOST = process.env.HOST ?? '127.0.0.1';

const ws = new Workspace(await createStore(STRATA_HOME), checkProjectId(process.env.STRATA_PROJECT ?? 'default'));
await ws.init();

const app = Fastify({ logger: { level: 'warn' } });

app.get('/api/workspace', async () => ws.state());

app.get('/api/graph', async () => ws.getGraph());

app.post<{ Body: { source?: string } }>('/api/repos', async (req, reply) => {
  const source = req.body?.source;
  if (typeof source !== 'string') return reply.code(400).send({ error: 'Body must be { "source": "<git url | org/repo | local path>" }' });
  try {
    await ws.add(source);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  return reply.code(202).send(ws.state());
});

app.delete<{ Params: { id: string } }>('/api/repos/:id', async (req) => {
  await ws.remove(req.params.id);
  return ws.state();
});

app.post<{ Params: { id: string } }>('/api/repos/:id/refresh', async (req, reply) => {
  ws.refresh(req.params.id);
  return reply.code(202).send(ws.state());
});

app.get('/api/grouping', async () => ({ grouping: ws.getGrouping(), presets: PRESETS, location: ws.state().project.groupingLocation }));

app.put('/api/grouping', async (req, reply) => {
  try {
    return { grouping: await ws.setGrouping(req.body) };
  } catch (err) {
    if (err instanceof GroupingError) return reply.code(400).send({ error: err.message });
    throw err;
  }
});

app.post<{ Body: { preset?: string } }>('/api/grouping/preset', async (req, reply) => {
  const preset = req.body?.preset as LayerPreset;
  if (!PRESETS.includes(preset)) return reply.code(400).send({ error: `preset must be one of ${PRESETS.join(', ')}` });
  return { grouping: await ws.applyPreset(preset) };
});

app.get<{ Querystring: { repo?: string; path?: string } }>('/api/source', async (req, reply) => {
  const { repo, path } = req.query;
  if (!repo || !path) return reply.code(400).send({ error: 'Query must be ?repo=<id>&path=<repo-relative path>' });
  const source = await ws.readSource(repo, path);
  if (!source) return reply.code(404).send({ error: `${repo}/${path} is not an indexed file` });
  return source;
});

await app.listen({ port: PORT, host: HOST });
console.log(`[strata] indexer listening on http://${HOST}:${PORT}`);
