// A stand-in for the Anthropic Messages API, for end-to-end runs without a
// key. Point the indexer at it with ANTHROPIC_BASE_URL and any
// ANTHROPIC_API_KEY. It streams answers the way the API does, shaped by the
// request's JSON schema, and answers the sort the way Claude Haiku did on
// the hosted indexer on 2026-10-08: each file's ref is its path, not the
// "F1" label the prompt gave it.
//
//   node web/e2e/mock-claude.mjs [port]        (prints the URL it listens on)
//
// Every request it answers is appended to MOCK_CLAUDE_LOG when that is set.

import fs from 'node:fs';
import http from 'node:http';

const words = (s) => s.replace(/[^a-z0-9]+/gi, ' ').trim();
const title = (s) => words(s).replace(/\b\w/g, (c) => c.toUpperCase());

/** The feature a path belongs to, by its folders: src/middleware/x.ts → middleware. */
function featureOf(path) {
  const parts = path.split('/').slice(1, -1).filter((p) => !['src', 'lib', 'app'].includes(p));

  if (parts[0] === 'tests' || parts[0] === 'test' || /\.test\./.test(path)) return 'tests';

  if (parts[0] === 'examples' || parts[0] === 'docs') return parts[0];

  if (!parts.length) return path.split('/').length <= 2 && !/\/src\//.test(path) ? 'tooling' : 'core';

  return parts[0];
}

/** Picks a layer from the request's own list. */
function layerFor(path, layers) {
  const has = (id) => (layers.includes(id) ? id : null);

  if (featureOf(path) === 'tests') return has('test') ?? layers[0];

  if (/\.(tsx|jsx)$/.test(path)) return has('ui') ?? layers[0];

  if (/config\.|rollup|vite/.test(path)) return has('job') ?? has('service') ?? layers[0];

  return has('client') ?? has('service') ?? layers[0];
}

/** A value that follows `schema`: the first enum value, a stand-in line for strings, one array item per id in an enum'd id field. */
function fill(schema) {
  if (schema.enum) return schema.enum[0];

  if (schema.type === 'string') return 'A line from the stand-in for Claude.';

  if (schema.type === 'array') {
    const item = schema.items ?? {};
    const idKey = Object.keys(item.properties ?? {}).find((k) => item.properties[k].enum);

    return idKey ? item.properties[idKey].enum.map((id) => ({ ...fill(item), [idKey]: id })) : [];
  }

  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, fill(v)]));

  return null;
}

function answer(body) {
  const schema = body.output_config?.format?.schema ?? {};
  const prompt = typeof body.messages[0].content === 'string' ? body.messages[0].content : '';
  const props = schema.properties ?? {};

  if (props.new_domains) {
    // Step 1: the leftover outline lists one file per line ("- repo/path (no layer)").
    const paths = [...prompt.matchAll(/^- (\S+\/\S+?)(?: \(no layer\))?$/gm)].map((m) => m[1]);
    const features = [...new Set(paths.map(featureOf))];

    return {
      domains: [],
      new_domains: features.map((f) => ({ id: f, name: title(f), reason: `the files under ${f}` })),
    };
  }

  if (props.files) {
    const item = props.files.items.properties;
    const layers = (item.layer.enum ?? []).filter(Boolean);
    const domains = (item.domain.enum ?? []).filter(Boolean);
    const files = [...prompt.matchAll(/^(F\d+) (\S+) \(/gm)].map((m) => m[2]);

    return {
      files: files.map((path) => {
        const f = featureOf(path);
        const layer = layers.length ? layerFor(path, layers) : '';

        return {
          ref: path,
          layer,
          layer_reason: layer ? `${path.split('/').pop()} sits with the other ${layer} code` : '',
          domain: domains.includes(f) ? f : (domains[0] ?? ''),
          reason: `it lives under ${f} with the rest of ${title(f).toLowerCase()}`,
          symbols: [],
        };
      }),
    };
  }

  return fill(schema);
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return res.writeHead(404).end();
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const text = JSON.stringify(answer(body));

    if (process.env.MOCK_CLAUDE_LOG) fs.appendFileSync(process.env.MOCK_CLAUDE_LOG, JSON.stringify({ at: new Date().toISOString(), request: body, answer: JSON.parse(text) }) + '\n');
    const message = { id: `msg_mock_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });

      return res.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: text.length } }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(sse('message_start', { message }));
    res.write(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }));
    res.write(sse('content_block_stop', { index: 0 }));
    res.write(sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: text.length } }));
    res.write(sse('message_stop', {}));
    res.end();
  });
});

const port = Number(process.argv[2] ?? 0);

server.listen(port, '127.0.0.1', () => console.log(`mock Claude on http://127.0.0.1:${server.address().port}`));
