import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicLLM, describeLLMError, llmFromEnv, OpenAIError, openaiLLM, type JsonRequest, type Post } from './llm.ts';

const req: JsonRequest = {
  label: 'leftovers 1/1',
  system: ['You sort code.', 'The project: app.'],
  prompt: 'Place these files.',
  schema: { type: 'object', additionalProperties: false, required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
};

// ── choosing a provider ──────────────────────────────────────────────

test('llmFromEnv: OpenAI first, Claude when it is the only key or the model asks for it', () => {
  assert.equal(llmFromEnv({}), null);
  assert.equal(llmFromEnv({ OPENAI_API_KEY: '  ' }), null);

  const openai = llmFromEnv({ OPENAI_API_KEY: '"sk-test"' })!;
  assert.equal(openai.label, 'OpenAI');
  assert.equal(openai.model, 'gpt-5.5');

  const claude = llmFromEnv({ ANTHROPIC_API_KEY: 'k' })!;
  assert.equal(claude.label, 'Claude');
  assert.equal(claude.model, 'claude-opus-5');

  assert.equal(llmFromEnv({ OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' })!.label, 'OpenAI');
  assert.equal(llmFromEnv({ OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', STRATA_LLM_MODEL: 'claude-sonnet-5' })!.model, 'claude-sonnet-5');
  assert.equal(llmFromEnv({ OPENAI_API_KEY: 'a', STRATA_LLM_MODEL: 'gpt-4.1' })!.model, 'gpt-4.1');
  // A Claude model left in .env doesn't break an OpenAI-only setup, nor the other way round.
  assert.equal(llmFromEnv({ OPENAI_API_KEY: 'a', STRATA_LLM_MODEL: 'claude-opus-5' })!.model, 'gpt-5.5');
  assert.equal(llmFromEnv({ ANTHROPIC_API_KEY: 'b', STRATA_LLM_MODEL: 'gpt-5' })!.model, 'claude-opus-5');
});

// ── OpenAI, with a mocked transport ──────────────────────────────────

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
function transport(...answers: (Answer | Error)[]) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const post: Post = async (url, headers, body) => {
    calls.push({ url, headers, body: JSON.parse(body) });
    const a = answers.shift();
    if (!a) throw new Error('no more answers');
    if (a instanceof Error) throw a;
    return { status: a.status, headers: a.headers ?? {}, body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) };
  };
  return { post, calls };
}
const completion = (content: string | null, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, refusal: null, ...extra } }] },
});
const apiError = (status: number, code: string | null, message = 'nope') => ({ status, body: { error: { message, type: 'invalid_request_error', code } } });
const quiet = { retryDelayMs: 0, log: () => {} };

test('openaiLLM: one strict json_schema request, answer parsed', async () => {
  const t = transport(completion('{"files":["a.py"]}'));
  const llm = openaiLLM('sk-test', 'gpt-5', { post: t.post, ...quiet });
  assert.deepEqual(await llm.json(req), { files: ['a.py'] });
  assert.equal(t.calls.length, 1);
  const [c] = t.calls;
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.headers.authorization, 'Bearer sk-test');
  assert.equal(c.body.model, 'gpt-5');
  assert.deepEqual(c.body.messages, [
    { role: 'system', content: 'You sort code.\n\nThe project: app.' },
    { role: 'user', content: 'Place these files.' },
  ]);
  assert.deepEqual(c.body.response_format, { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: req.schema } });
});

test('openaiLLM: retries rate limits, server errors and dropped connections, then gives up', async () => {
  const t = transport(apiError(429, 'rate_limit_exceeded'), apiError(500, null), new Error('socket hang up'), completion('{"files":[]}'));
  assert.deepEqual(await openaiLLM('k', 'gpt-5', { post: t.post, ...quiet }).json(req), { files: [] });
  assert.equal(t.calls.length, 4);

  const down = transport(apiError(503, null), apiError(503, null), apiError(503, null), apiError(503, null));
  await assert.rejects(openaiLLM('k', 'gpt-5', { post: down.post, ...quiet }).json(req), (err: OpenAIError) => err.status === 503);
  assert.equal(down.calls.length, 4);
});

test("openaiLLM: an account out of credit or a rejected key isn't retried", async () => {
  const quota = transport(apiError(429, 'insufficient_quota', 'You exceeded your current quota'));
  const err = await openaiLLM('k', 'gpt-5', { post: quota.post, ...quiet }).json(req).catch((e) => e);
  assert.equal(quota.calls.length, 1);
  assert.match(describeLLMError(err), /out of credit/);

  const bad = transport(apiError(401, 'invalid_api_key'));
  const err2 = await openaiLLM('k', 'gpt-5', { post: bad.post, ...quiet }).json(req).catch((e) => e);
  assert.equal(bad.calls.length, 1);
  assert.equal(describeLLMError(err2), 'The OpenAI API key was rejected. Check OPENAI_API_KEY on the indexer.');
});

test("openaiLLM: without a model, moves down the defaults when the key can't use one", async () => {
  const lines: string[] = [];
  const t = transport(apiError(404, 'model_not_found', 'The model `gpt-5.5` does not exist'), completion('{"files":[]}'), completion('{"files":["b"]}'));
  const llm = openaiLLM('k', undefined, { post: t.post, retryDelayMs: 0, log: (l) => lines.push(l) });
  assert.equal(llm.model, 'gpt-5.5');
  await llm.json(req);
  assert.equal(llm.model, 'gpt-5');
  await llm.json(req);
  assert.deepEqual(t.calls.map((c) => c.body.model), ['gpt-5.5', 'gpt-5', 'gpt-5']);
  assert.deepEqual(lines, ['[strata] OpenAI has no gpt-5.5 for this key; using gpt-5']);

  // A model someone chose is used or reported, never swapped.
  const chosen = transport(apiError(404, 'model_not_found'));
  const err = await openaiLLM('k', 'gpt-9', { post: chosen.post, ...quiet }).json(req).catch((e) => e);
  assert.equal(chosen.calls.length, 1);
  assert.equal(describeLLMError(err), "The OpenAI API key can't use gpt-9. Set STRATA_LLM_MODEL to a model it has.");
});

test('openaiLLM: refusals, cut-off answers and unreachable API read plainly', async () => {
  const refused = transport(completion(null, { refusal: "I can't help with that." }));
  await assert.rejects(openaiLLM('k', 'gpt-5', { post: refused.post, ...quiet }).json(req), /OpenAI declined the leftovers 1\/1 request/);

  const long = transport({ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{"files":[' } }] } });
  await assert.rejects(openaiLLM('k', 'gpt-5', { post: long.post, ...quiet }).json(req), /cut off/);

  const offline = transport(...Array.from({ length: 4 }, () => new Error('getaddrinfo ENOTFOUND api.openai.com')));
  const err = await openaiLLM('k', 'gpt-5', { post: offline.post, ...quiet }).json(req).catch((e) => e);
  assert.equal(describeLLMError(err), "Couldn't reach the OpenAI API.");
});

// ── Claude, with a mocked fetch ──────────────────────────────────────

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const claudeStream = (text: string, stop = 'end_turn') =>
  sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);

function claudeFetch(...answers: (() => Response)[]) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return answers.shift()!();
  }) as typeof fetch;
  return { fetch: f, calls };
}

test('anthropicLLM: structured output streamed and parsed, cached system context', async () => {
  const t = claudeFetch(() => claudeStream('{"files":["a.py"]}'));
  const llm = anthropicLLM('k', 'claude-opus-5', { fetch: t.fetch });
  assert.deepEqual(await llm.json(req), { files: ['a.py'] });
  const [c] = t.calls;
  assert.match(c.url, /\/v1\/messages/);
  assert.equal(c.body.model, 'claude-opus-5');
  assert.deepEqual(c.body.output_config, { format: { type: 'json_schema', schema: req.schema } });
  assert.equal(c.body.system.length, 2);
  assert.deepEqual(c.body.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(c.body.system[0].cache_control, undefined);
  assert.equal(c.body.fallbacks, 'default');
});

test("anthropicLLM: asks again without fallbacks when the key can't use them, and reports refusals", async () => {
  const t = claudeFetch(
    () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not available' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    () => claudeStream('{"files":[]}'),
    () => claudeStream('', 'refusal'),
  );
  const llm = anthropicLLM('k', 'claude-opus-5', { fetch: t.fetch });
  assert.deepEqual(await llm.json(req), { files: [] });
  assert.equal(t.calls[0].body.fallbacks, 'default');
  assert.equal(t.calls[1].body.fallbacks, undefined);
  await assert.rejects(llm.json(req), /Claude declined the leftovers 1\/1 request/);
  assert.equal(t.calls[2].body.fallbacks, undefined);
});

test('describeLLMError: Anthropic errors name their own key', async () => {
  const t = claudeFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
  const err = await anthropicLLM('k', 'claude-opus-5', { fetch: t.fetch }).json(req).catch((e) => e);
  assert.equal(describeLLMError(err), 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the indexer.');
});
