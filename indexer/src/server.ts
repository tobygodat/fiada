// HTTP API the map talks to. Binds to localhost: importing a local path reads
// that directory, so this is a single-user development tool, not a service.

import Fastify from 'fastify';
import { Workspace } from './workspace.ts';

const PORT = Number(process.env.PORT ?? 4178);
const HOST = process.env.HOST ?? '127.0.0.1';

const ws = new Workspace();
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

await app.listen({ port: PORT, host: HOST });
console.log(`[strata] indexer listening on http://${HOST}:${PORT}`);
