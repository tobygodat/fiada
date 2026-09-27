// HTTP API the map talks to. Binds to localhost by default: importing a local
// path reads that directory, so on your own machine it's a single-user tool.
// Bound anywhere else (HOST=0.0.0.0 in the container, and by default on
// Railway, Render and Fly), local paths are off,
// browsers on FIADA_ALLOWED_ORIGINS may call it, and with FIADA_API_KEY set
// only requests carrying the key can change anything.

import './env.ts';
import type { OutgoingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import type { AgentEvent, LayerPreset } from '@fiada/shared';
import { allowLocalPaths, defaultHost, hasKey, isLoopback, originMatcher, READS } from './access.ts';
import { AgentHub } from './agents.ts';
import { GroupingError, PRESETS } from './classify/index.ts';
import { KEY_HINT, llmFromEnv } from './llm.ts';
import { Sorter } from './sorter.ts';
import { checkProjectId, createStore } from './store.ts';
import { Summaries } from './summaries/index.ts';
import { archiveLimit, tooBig, UPLOAD, UploadError } from './upload.ts';
import { FIADA_HOME, Workspace } from './workspace.ts';

const PORT = Number(process.env.PORT ?? 4178);
const HOST = process.env.HOST || defaultHost();
const KEY = process.env.FIADA_API_KEY || undefined;
const allowedOrigin = originMatcher(process.env.FIADA_ALLOWED_ORIGINS);

const store = await createStore(FIADA_HOME);
const ws = new Workspace(
  store,
  checkProjectId(process.env.FIADA_PROJECT ?? 'default'),
  { localPaths: allowLocalPaths(HOST), keyRequired: !!KEY },
  Sorter.fromEnv(),
);
const llm = /^(off|0|false|no)$/i.test(process.env.FIADA_SUMMARIES?.trim() ?? '') ? null : llmFromEnv();
const summaries = new Summaries({
  store,
  projectId: ws.projectId,
  llm,
  read: (repo, path) => ws.readSource(repo, path).then((s) => s?.text ?? null),
  busy: () => ws.state().busy,
});
await summaries.init();
ws.onGraph(() => summaries.setGraph(ws.getGraph()));
await ws.init();
summaries.setGraph(ws.getGraph());
const agents = new AgentHub(ws);

const app = Fastify({ logger: { level: 'warn' } });

// CORS for the map served from another origin, then the key for anything that isn't a read.
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  reply.header('vary', 'origin');
  if (allowedOrigin(origin)) reply.header('access-control-allow-origin', origin);
  if (req.method === 'OPTIONS') {
    reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE');
    reply.header('access-control-allow-headers', 'content-type, authorization');
    reply.header('access-control-max-age', '600');
    return reply.code(204).send();
  }
  if (KEY && !READS.has(req.method) && !hasKey(req.headers.authorization, KEY)) {
    return reply.code(401).send({ error: "This map is read-only without the indexer's access key. Open it once with ?key=<key> to make changes." });
  }
});

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

// A folder uploaded from the map, as a gzipped tar (see upload.ts). Uploading
// the same folder again replaces it; ?replace=<id> says which one to replace.
const UPLOAD_LIMIT = archiveLimit(UPLOAD);
app.addContentTypeParser(['application/gzip', 'application/x-gzip'], { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));

app.post<{ Querystring: { name?: string; replace?: string } }>(
  '/api/repos/upload',
  {
    bodyLimit: UPLOAD_LIMIT,
    errorHandler: (err, _req, reply) => {
      if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: tooBig(UPLOAD).message });
      reply.send(err);
    },
  },
  async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the folder as a gzipped tar (content-type: application/gzip) with ?name=<folder name>.' });
    try {
      await ws.upload(req.query.name ?? '', req.body, req.query.replace || undefined);
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    return reply.code(202).send(ws.state());
  },
);

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

// Sorts the project's leftovers with the model again. Answers at once; the map picks the result up when it lands.
app.post('/api/grouping/sort', async (_req, reply) => {
  if (!ws.sortAgain()) return reply.code(409).send({ error: `Sorting is unavailable: the indexer has no ${KEY_HINT}.` });
  return reply.code(202).send(ws.state());
});

app.get<{ Querystring: { repo?: string; path?: string } }>('/api/source', async (req, reply) => {
  const { repo, path } = req.query;
  if (!repo || !path) return reply.code(400).send({ error: 'Query must be ?repo=<id>&path=<repo-relative path>' });
  const source = await ws.readSource(repo, path);
  if (!source) return reply.code(404).send({ error: `${repo}/${path} is not an indexed file` });
  return source;
});

// What a node does: a line from the graph straight away, and a generated summary when a model key is set.
app.get<{ Querystring: { node?: string } }>('/api/summary', async (req, reply) => {
  if (!req.query.node) return reply.code(400).send({ error: 'Query must be ?node=<node id>' });
  const summary = await summaries.get(req.query.node);
  if (!summary) return reply.code(404).send({ error: `${req.query.node} is not in the graph` });
  return summary;
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
  // Hijacked, so the CORS headers set above go out by hand.
  res.writeHead(200, { ...(reply.getHeaders() as OutgoingHttpHeaders), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
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

// One agent (?id=) or all of them. The id goes in the query: it holds the checkout's
// absolute path, often longer than a path parameter may be.
app.delete<{ Querystring: { id?: string } }>('/api/agent', async (req) => {
  agents.clear(req.query.id || undefined);
  return agents.state();
});

await app.listen({ port: PORT, host: HOST });
console.log(`[fiada] indexer listening on http://${HOST}:${PORT}`);
if (!ws.allowLocal) console.log('[fiada] local folders are off: this indexer imports git repositories only');
if (process.env.FIADA_ALLOWED_ORIGINS) console.log(`[fiada] browsers may call the API from ${process.env.FIADA_ALLOWED_ORIGINS}`);
console.log(ws.sorter.available ? `[fiada] sorting imports with ${ws.sorter.describe}` : `[fiada] no ${KEY_HINT}: imports keep the classifier's sort, with leftovers in Unlayered and Unsorted`);
console.log(llm ? `[fiada] node summaries: written by ${llm.label} (${llm.model})` : `[fiada] no ${KEY_HINT}: node summaries are lines from the graph`);
if (KEY) console.log('[fiada] changes need the access key (FIADA_API_KEY)');
else if (!isLoopback(HOST)) console.warn('[fiada] no FIADA_API_KEY: anyone who can reach this indexer can change its project');
