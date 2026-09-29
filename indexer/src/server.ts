// HTTP API the map talks to. Binds to localhost by default: importing a local
// path reads that directory, so on your own machine it's a single-user tool.
// Bound anywhere else (HOST=0.0.0.0 in the container, and by default on
// Railway, Render and Fly), local paths are off and browsers on
// FIADA_ALLOWED_ORIGINS may call it.
//
// Who may do what comes in two modes:
//   GitHub sign-in (FIADA_GITHUB_CLIENT_ID and _SECRET set): every request
//     needs a signed-in person, and each person works in a project of their
//     own (tenants.ts). Agents report with that person's agent token.
//   No sign-in: one shared project; with FIADA_API_KEY set, only requests
//     carrying the key can change anything.

import './env.ts';
import type { OutgoingHttpHeaders } from 'node:http';
import Fastify, { type FastifyRequest } from 'fastify';
import type { AccountInfo, AgentConnection, AgentEvent, AuthState, LayerPreset } from '@fiada/shared';
import { allowLocalPaths, defaultHost, hasKey, isLoopback, originMatcher, READS } from './access.ts';
import { accountInfo, Auth, authConfigFromEnv, bearer, CALLBACK_PATH, cookie, NONCE_COOKIE, returnAllowed } from './auth.ts';
import { GroupingError, PRESETS } from './classify/index.ts';
import { KEY_HINT, llmFromEnv } from './llm.ts';
import { checkProjectId, createStore } from './store.ts';
import { clonesOf, openTenant, Tenants, type Tenant } from './tenants.ts';
import { archiveLimit, tooBig, UPLOAD, UploadError } from './upload.ts';
import { CLONES, FIADA_HOME } from './workspace.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The project this request works in: the shared one, or the signed-in person's own. */
    tenant: Tenant;
  }
}

const PORT = Number(process.env.PORT ?? 4178);
const HOST = process.env.HOST || defaultHost();
const KEY = process.env.FIADA_API_KEY || undefined;
// The map's own domains are always allowed, so the hosted map works without editing the host's variables.
const MAP_ORIGINS = 'https://fiada.tech,https://www.fiada.tech,https://hackgt13.vercel.app';
const allowedOrigin = originMatcher([MAP_ORIGINS, process.env.FIADA_ALLOWED_ORIGINS].filter(Boolean).join(','));
/** The indexer's own URL as others reach it, when the request can't be trusted to say (FIADA_PUBLIC_URL). */
const PUBLIC_URL = process.env.FIADA_PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined;

const store = await createStore(FIADA_HOME);
const sortLlm = llmFromEnv();
const summaryLlm = /^(off|0|false|no)$/i.test(process.env.FIADA_SUMMARIES?.trim() ?? '') ? null : llmFromEnv(process.env, 'summaries');
const authConfig = authConfigFromEnv();
const auth = authConfig ? new Auth(store, authConfig) : null;

/** Without sign-in: the one project everybody shares. */
const shared = auth
  ? null
  : await openTenant({
      store,
      projectId: checkProjectId(process.env.FIADA_PROJECT ?? 'default'),
      access: { localPaths: allowLocalPaths(HOST), keyRequired: !!KEY },
      sortLlm,
      summaryLlm,
      clones: CLONES,
      githubToken: () => process.env.FIADA_GITHUB_TOKEN,
    });

/** With sign-in: each person's own project, as they last signed in. */
const people = new Map<string, AccountInfo>();
const tenants = new Tenants(async (projectId) => {
  let recent: string[] = [];
  auth!.recentRepos(projectId).then((r) => (recent = r), () => undefined);
  return openTenant({
    store,
    projectId,
    // Local folders would be the indexer's own disk, which is nobody's project.
    access: { localPaths: false, keyRequired: false },
    sortLlm,
    summaryLlm,
    clones: clonesOf(FIADA_HOME, projectId),
    githubToken: () => auth!.githubToken(projectId),
    suggestions: () => (recent.length ? recent : null),
    account: () => people.get(projectId),
  });
});

const SIGN_IN = 'Sign in with GitHub to use this map.';
const AGENT_SIGN_IN = 'This agent token is not valid (it may have been reset). Copy the command from the map again.';

/** The indexer's URL as the caller reached it: behind the dev server's proxy, or the host's. */
const publicUrl = (req: FastifyRequest) => PUBLIC_URL ?? `${req.protocol}://${req.host}`;

// Behind a host's proxy (and the dev server's), the forwarded headers say the scheme and host the browser used.
const app = Fastify({ logger: { level: 'warn' }, trustProxy: true });
app.decorateRequest('tenant', null as unknown as Tenant);

// CORS for the map served from another origin, then who is asking and which project that is.
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
  const route = req.url.split('?')[0];
  // Signing in answers for itself.
  if (route === '/api/auth' || route.startsWith('/api/auth/')) return;
  if (!auth) {
    if (KEY && !READS.has(req.method) && !hasKey(req.headers.authorization, KEY)) {
      return reply.code(401).send({ error: "This map is read-only without the indexer's access key. Open it once with ?key=<key> to make changes." });
    }
    req.tenant = shared!;
    return;
  }
  // Agents may only report; everything else takes a signed-in browser.
  const agentRoute = req.method === 'POST' && route === '/api/agent/events';
  const token = bearer(req.headers.authorization);
  const account = agentRoute ? await auth.agent(token) : await auth.session(token);
  if (!account) return reply.code(401).send({ error: agentRoute ? AGENT_SIGN_IN : SIGN_IN, signIn: !agentRoute });
  const info = accountInfo(account);
  people.set(account.id, info);
  req.tenant = await tenants.get(account.id, info);
});

// ── signing in ──

app.get('/api/auth', async (req): Promise<AuthState> => {
  if (!auth) return { mode: 'off' };
  const account = await auth.session(bearer(req.headers.authorization));
  return account ? { mode: 'github', account: accountInfo(account) } : { mode: 'github' };
});

// The map sends the browser here with ?return=<its own address>; GitHub sends it back to the callback.
app.get<{ Querystring: { return?: string } }>('/api/auth/github/login', async (req, reply) => {
  if (!auth) return reply.code(404).send({ error: 'This indexer has no GitHub sign-in.' });
  const own = new URL(publicUrl(req)).origin;
  const returnTo = req.query.return ?? `${own}/`;
  if (!returnAllowed(returnTo, own, allowedOrigin)) {
    return reply.code(400).send({ error: `This indexer can't sign you in for ${returnTo}: add its origin to FIADA_ALLOWED_ORIGINS.` });
  }
  const { url, nonce } = auth.begin(returnTo, `${publicUrl(req)}${CALLBACK_PATH}`);
  const secure = req.protocol === 'https' ? '; Secure' : '';
  reply.header('set-cookie', `${NONCE_COOKIE}=${nonce}; Path=/api/auth/github; Max-Age=600; HttpOnly; SameSite=Lax${secure}`);
  return reply.redirect(url);
});

// The session goes back in the address's fragment, which browsers never send to a server.
app.get<{ Querystring: { code?: string; state?: string; error_description?: string } }>(CALLBACK_PATH, async (req, reply) => {
  if (!auth) return reply.code(404).send({ error: 'This indexer has no GitHub sign-in.' });
  reply.header('set-cookie', `${NONCE_COOKIE}=; Path=/api/auth/github; Max-Age=0; HttpOnly; SameSite=Lax`);
  try {
    if (req.query.error_description) throw new Error(req.query.error_description);
    const done = await auth.finish(req.query.code, req.query.state, cookie(req.headers.cookie, NONCE_COOKIE), `${publicUrl(req)}${CALLBACK_PATH}`);
    people.set(done.account.id, accountInfo(done.account));
    console.log(`[fiada] ${done.account.login} signed in`);
    return reply.redirect(`${done.returnTo.split('#')[0]}#fiada_session=${encodeURIComponent(done.session)}`);
  } catch (err) {
    const message = (err as Error).message;
    const back = auth.returnOf(req.query.state);
    if (back && returnAllowed(back, new URL(publicUrl(req)).origin, allowedOrigin)) {
      return reply.redirect(`${back.split('#')[0]}#fiada_error=${encodeURIComponent(message)}`);
    }
    return reply.code(400).send({ error: message });
  }
});

/** The signed-in person's account, for the routes under /api/auth, which check it themselves. */
async function signedIn(req: FastifyRequest) {
  return auth ? auth.session(bearer(req.headers.authorization)) : null;
}

// What `npm run agent:setup` needs to report to this person's map.
app.get('/api/auth/agent', async (req, reply): Promise<AgentConnection | void> => {
  if (!auth) return { url: publicUrl(req) };
  const account = await signedIn(req);
  if (!account) return reply.code(401).send({ error: SIGN_IN, signIn: true });
  return { url: publicUrl(req), token: auth.agentToken(account) };
});

// A new agent token; agents set up with the old one stop reporting.
app.post('/api/auth/agent/reset', async (req, reply): Promise<AgentConnection | void> => {
  const account = await signedIn(req);
  if (!auth || !account) return reply.code(401).send({ error: SIGN_IN, signIn: true });
  return { url: publicUrl(req), token: await auth.resetAgentToken(account) };
});

// ── the project ──

app.get('/api/workspace', async (req) => req.tenant.ws.state());

app.get('/api/graph', async (req) => req.tenant.ws.getGraph());

app.post<{ Body: { source?: string } }>('/api/repos', async (req, reply) => {
  const source = req.body?.source;
  if (typeof source !== 'string') return reply.code(400).send({ error: 'Body must be { "source": "<git url | org/repo | local path>" }' });
  try {
    await req.tenant.ws.add(source);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  return reply.code(202).send(req.tenant.ws.state());
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
      await req.tenant.ws.upload(req.query.name ?? '', req.body, req.query.replace || undefined);
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    return reply.code(202).send(req.tenant.ws.state());
  },
);

app.delete<{ Params: { id: string } }>('/api/repos/:id', async (req) => {
  await req.tenant.ws.remove(req.params.id);
  return req.tenant.ws.state();
});

app.post<{ Params: { id: string } }>('/api/repos/:id/refresh', async (req, reply) => {
  req.tenant.ws.refresh(req.params.id);
  return reply.code(202).send(req.tenant.ws.state());
});

app.get('/api/grouping', async (req) => ({ grouping: req.tenant.ws.getGrouping(), presets: PRESETS, location: req.tenant.ws.state().project.groupingLocation }));

app.put('/api/grouping', async (req, reply) => {
  try {
    return { grouping: await req.tenant.ws.setGrouping(req.body) };
  } catch (err) {
    if (err instanceof GroupingError) return reply.code(400).send({ error: err.message });
    throw err;
  }
});

app.post<{ Body: { preset?: string } }>('/api/grouping/preset', async (req, reply) => {
  const preset = req.body?.preset as LayerPreset;
  if (!PRESETS.includes(preset)) return reply.code(400).send({ error: `preset must be one of ${PRESETS.join(', ')}` });
  return { grouping: await req.tenant.ws.applyPreset(preset) };
});

// Sorts the project's leftovers with the model again. Answers at once; the map picks the result up when it lands.
app.post('/api/grouping/sort', async (req, reply) => {
  if (!req.tenant.ws.sortAgain()) return reply.code(409).send({ error: `Sorting is unavailable: the indexer has no ${KEY_HINT}.` });
  return reply.code(202).send(req.tenant.ws.state());
});

app.get<{ Querystring: { repo?: string; path?: string } }>('/api/source', async (req, reply) => {
  const { repo, path } = req.query;
  if (!repo || !path) return reply.code(400).send({ error: 'Query must be ?repo=<id>&path=<repo-relative path>' });
  const source = await req.tenant.ws.readSource(repo, path);
  if (!source) return reply.code(404).send({ error: `${repo}/${path} is not an indexed file` });
  return source;
});

// What a node does: a line from the graph straight away, and a generated summary when a model key is set.
app.get<{ Querystring: { node?: string } }>('/api/summary', async (req, reply) => {
  if (!req.query.node) return reply.code(400).send({ error: 'Query must be ?node=<node id>' });
  const summary = await req.tenant.summaries.get(req.query.node);
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
  return req.tenant.agents.ingest(events);
});

app.get('/api/agent/state', async (req) => req.tenant.agents.state());

app.get('/api/agent/stream', (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  // Hijacked, so the CORS headers set above go out by hand.
  res.writeHead(200, { ...(reply.getHeaders() as OutgoingHttpHeaders), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (s: unknown) => res.write(`data: ${JSON.stringify(s)}\n\n`);
  send(req.tenant.agents.state());
  const off = req.tenant.agents.subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.raw.on('close', () => {
    off();
    clearInterval(ping);
  });
});

app.get<{ Querystring: { node?: string } }>('/api/agent/diff', async (req, reply) => {
  if (!req.query.node) return reply.code(400).send({ error: 'Query must be ?node=<file or symbol id>' });
  return { diffs: req.tenant.agents.diffs(req.query.node) };
});

// One agent (?id=) or all of them. The id goes in the query: it holds the checkout's
// absolute path, often longer than a path parameter may be.
app.delete<{ Querystring: { id?: string } }>('/api/agent', async (req) => {
  req.tenant.agents.clear(req.query.id || undefined);
  return req.tenant.agents.state();
});

await app.listen({ port: PORT, host: HOST });
console.log(`[fiada] indexer listening on http://${HOST}:${PORT}`);
if (auth) {
  console.log(`[fiada] GitHub sign-in is on: each person gets a project of their own (callback ${PUBLIC_URL ?? '<this indexer>'}${CALLBACK_PATH})`);
  if (KEY) console.log('[fiada] FIADA_API_KEY is not used while GitHub sign-in is on');
} else if (!shared!.ws.allowLocal) console.log('[fiada] local folders are off: this indexer imports git repositories only');
if (process.env.FIADA_ALLOWED_ORIGINS) console.log(`[fiada] browsers may call the API from ${process.env.FIADA_ALLOWED_ORIGINS}`);
console.log(sortLlm ? `[fiada] sorting imports with ${sortLlm.label} (${sortLlm.model})` : `[fiada] no ${KEY_HINT}: imports keep the classifier's sort, with leftovers in Unlayered and Unsorted`);
console.log(summaryLlm ? `[fiada] node summaries: written by ${summaryLlm.label} (${summaryLlm.model})` : `[fiada] no ${KEY_HINT}: node summaries are lines from the graph`);
if (!auth) {
  if (KEY) console.log('[fiada] changes need the access key (FIADA_API_KEY)');
  else if (!isLoopback(HOST)) console.warn('[fiada] no FIADA_API_KEY or GitHub sign-in: anyone who can reach this indexer can change its project');
}
