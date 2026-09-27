// HTTP API the map talks to. Binds to localhost: importing a local path reads
// that directory, so this is a single-user development tool, not a service.

import './env.ts';
import Fastify from 'fastify';
import type { AgentEvent, LayerPreset } from '@strata/shared';
import { AgentHub } from './agents.ts';
import { GroupingError, PRESETS } from './classify/index.ts';
import { checkProjectId, createStore } from './store.ts';
import { STRATA_HOME, Workspace } from './workspace.ts';

const PORT = Number(process.env.PORT ?? 4178);
const HOST = process.env.HOST ?? '127.0.0.1';

const ws = new Workspace(await createStore(STRATA_HOME), checkProjectId(process.env.STRATA_PROJECT ?? 'default'));
await ws.init();
const agents = new AgentHub(ws);

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

// ── agent activity ──
// The agent package's MCP server and hooks post here; the map listens on the stream.

// A sweep can carry many diffs (each capped at 64 KB), so this route takes more than the default 1 MB.
app.post('/api/agent/events', { bodyLimit: 32 << 20 }, async (req, reply) => {
  const body = req.body as AgentEvent | AgentEvent[] | undefined;
  const events = Array.isArray(body) ? body : body ? [body] : [];
  if (!events.every((e) => e && typeof e === 'object' && typeof e.type === 'string' && e.agent && typeof e.agent.cwd === 'string')) {
    return reply.code(400).send({ error: 'Body must be an agent event or a list of them: { type, agent: { client, cwd, … }, … }' });
  }
  return agents.ingest(events);
});

app.get('/api/agent/state', async () => agents.state());

app.get('/api/agent/stream', (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (s: unknown) => res.write(`data: ${JSON.stringify(s)}\n\n`);
  send(agents.state());
  const off = agents.subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.raw.on('close', () => {
    off();
    clearInterval(ping);
  });
});

app.get<{ Querystring: { node?: string } }>('/api/agent/diff', async (req, reply) => {
  if (!req.query.node) return reply.code(400).send({ error: 'Query must be ?node=<file or symbol id>' });
  return { diffs: agents.diffs(req.query.node) };
});

app.delete<{ Params: { id: string } }>('/api/agent/:id', async (req) => {
  agents.clear(req.params.id);
  return agents.state();
});

app.delete('/api/agent', async () => {
  agents.clear();
  return agents.state();
});

await app.listen({ port: PORT, host: HOST });
console.log(`[strata] indexer listening on http://${HOST}:${PORT}`);
