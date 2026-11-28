// The indexer's one way to ask a language model something, so features that
// need one (sorting a project's leftovers, summaries) share the key, the
// model and the error messages. Two providers: Claude through the Anthropic
// API, with the key in ANTHROPIC_API_KEY, and OpenAI, with the key in
// OPENAI_API_KEY. Without either key, llmFromEnv() is null and each
// feature says it is unavailable rather than failing.
//
// With sign-in, each person brings their own key instead (personalLLM): the
// map keeps it in their browser and sends it with each request, and the
// indexer holds it in memory for their open project only (docs/adr/0005).

import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { request as httpsRequest } from 'node:https';
import { unquote } from './postgres-store.ts';
import { messageOf, type Json, type JsonObject } from '@fiada/shared';

export { MODEL_KEY_HEADER } from '@fiada/shared';

/** One request whose answer must parse as JSON following `schema`. */
export interface JsonRequest {
  /** Short name for logs and errors, e.g. "domains" or "leftovers 2/8". */
  label: string;
  /** Instructions first, then context shared by a run's requests (the last part is cached across them). */
  system: string[];
  prompt: string;
  /** JSON Schema. Every object needs additionalProperties: false and all of its properties required. */
  schema: JsonObject;
}

export interface LLM {
  /** Who answers, for people: "OpenAI" or "Claude". */
  label: string;
  /** The model id, e.g. "claude-haiku-5-5" or "gpt-5.5". */
  model: string;
  json(req: JsonRequest): Promise<Json>;
}

/** Claude's default model, for sorting and summaries alike. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** OpenAI's default model, then the ones to try when a key can't use it. */
export const DEFAULT_OPENAI_MODELS = ['gpt-5.5', 'gpt-5', 'gpt-4.1'];

/**
 * OpenAI's default for summaries: short lines, many of them, written on
 * every import, where a smaller model does as well for far less.
 */
export const SUMMARY_OPENAI_MODELS = ['gpt-5-mini', ...DEFAULT_OPENAI_MODELS];

const providerOf = (model: string) => (/^claude/i.test(model) ? 'anthropic' : /^(gpt|chatgpt|o\d)/i.test(model) ? 'openai' : undefined);

/**
 * Claude when ANTHROPIC_API_KEY is set, else OpenAI when OPENAI_API_KEY is;
 * null without either. FIADA_LLM_MODEL picks the model that sorts, and an
 * OpenAI model there picks OpenAI when both keys are set. Summaries use
 * FIADA_SUMMARY_MODEL, else a smaller OpenAI model (Claude keeps its
 * default), on the provider FIADA_LLM_MODEL picked. A model of the other
 * provider's is ignored, so a leftover FIADA_LLM_MODEL=gpt-… doesn't break
 * an Anthropic key.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env, use: 'sort' | 'summaries' = 'sort', wire: Wire = {}): LLM | null {
  const openai = unquote(env.OPENAI_API_KEY);
  const anthropic = unquote(env.ANTHROPIC_API_KEY);
  const own = (use === 'summaries' && env.FIADA_SUMMARY_MODEL?.trim()) || undefined;
  const model = own ?? (env.FIADA_LLM_MODEL?.trim() || undefined);
  const wants = model && providerOf(model);

  if (anthropic && !(wants === 'openai' && openai)) return anthropicLLM(anthropic, (wants !== 'openai' && model) || DEFAULT_MODEL, wire);

  if (openai) {
    if (use === 'summaries' && !own) return openaiLLM(openai, SUMMARY_OPENAI_MODELS, { post: wire.post });

    return openaiLLM(openai, wants === 'anthropic' ? undefined : model, { post: wire.post });
  }

  return null;
}

/** How a model's requests go out: `fetch` for Claude, `post` for OpenAI, and for a person's own key, only to the provider itself. */
export interface Wire {
  fetch?: typeof fetch;
  post?: Post;
  /** The provider's own endpoint and nothing from the host's environment: no ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or SDK logging. */
  own?: boolean;
}

/** Where to set a key, for messages that say a feature is unavailable. */
export const KEY_HINT = 'ANTHROPIC_API_KEY or OPENAI_API_KEY';

// ── a person's own key ─────────────────────────────────────────────────

/** A signed-in person's own model key. */
export interface ModelKey {
  provider: 'anthropic' | 'openai';
  key: string;
}

/** Where a signed-in person adds their key, for messages that say a feature is unavailable. */
export const OWN_KEY_HINT = 'your Anthropic or OpenAI key, under model key in the sidebar';

const PROVIDER_NAME = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

/** A key as pasted: Anthropic's start sk-ant-, OpenAI's sk-. Null for anything else. */
export function modelKeyOf(raw: unknown): ModelKey | null {
  const key = typeof raw === 'string' ? raw.trim() : '';

  if (key.length < 20 || key.length > 512 || !/^sk-[A-Za-z0-9_-]+$/.test(key)) return null;

  return { provider: key.startsWith('sk-ant-') ? 'anthropic' : 'openai', key };
}

/**
 * The model a person's key answers with, picked as llmFromEnv picks it for
 * the indexer's own key. Its errors tell the person to fix their key, and once
 * `live` turns false (the key was replaced or removed) nothing more goes out,
 * retries included; a request already sent finishes. `base` is for tests.
 */
export function personalLLM(k: ModelKey, use: 'sort' | 'summaries', live: () => boolean, env: NodeJS.ProcessEnv = process.env, base: Pick<Wire, 'fetch' | 'post'> = {}): LLM {
  const name = k.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const send = base.post ?? httpsPost();

  const wire: Wire = {
    own: true,
    fetch: (input, init) => (live() ? (base.fetch ?? fetch)(input, init) : Promise.reject(removed())),
    post: (url, headers, body) => (live() ? send(url, headers, body) : Promise.reject(removed())),
  };

  return asYours(llmFromEnv({ FIADA_LLM_MODEL: env.FIADA_LLM_MODEL, FIADA_SUMMARY_MODEL: env.FIADA_SUMMARY_MODEL, [name]: k.key }, use, wire)!, live);
}

const removed = () => new Error('Your model key was removed.');

/** `llm` answering on a person's own key: see personalLLM. */
export function asYours(llm: LLM, live: () => boolean): LLM {
  return {
    get label() {
      return llm.label;
    },
    get model() {
      return llm.model;
    },
    async json(req) {
      if (!live()) throw removed();

      try {
        return await llm.json(req);
      } catch (err) {
        if (!live()) throw removed();

        if (err instanceof OpenAIError || err instanceof Anthropic.APIError) throw new Error(describeLLMError(err, 'yours'));
        throw err;
      }
    },
  };
}

/**
 * Checks a person's key by listing the models it can use, which costs
 * nothing. Null when the provider accepts it, else a sentence saying why not.
 * Never reads the provider's answer, so nothing it echoes reaches a message.
 */
export async function checkModelKey(k: ModelKey, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const name = PROVIDER_NAME[k.provider];

  const [url, headers] =
    k.provider === 'anthropic'
      ? ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': k.key, 'anthropic-version': '2023-06-01' }]
      : ['https://api.openai.com/v1/models', { authorization: `Bearer ${k.key}` }];

  let status: number;

  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    status = res.status;
    await res.body?.cancel();
  } catch {
    return `Couldn't reach ${name} to check the key. Try again in a minute.`;
  }

  if (status >= 200 && status < 300) return null;

  if (status === 401) return `${name} didn't accept that key. Check that you copied all of it, or make a new one.`;

  if (status === 403) return `${name} accepted that key but won't let it be used. Check that it is active, or make a new one.`;

  if (status === 429) return `${name} is rate limiting that key. Try again in a minute.`;

  return `${name} answered ${status} when checking the key. Try again in a minute.`;
}

/** Text with anything shaped like an API key taken out, for messages and logs that quote a provider's answer. */
export const redactKeys = (text: string) => text.replace(/sk-[A-Za-z0-9_*.-]{4,}/g, 'sk-…');

/**
 * Claude through the Anthropic API. Structured output, so every answer
 * parses against the request's schema; streamed, since answers can be long.
 * Opts into server-side fallbacks, so a declined request is retried on
 * another model; if the key's organisation can't use them, it asks again
 * without. Haiku has none to opt into. `opts` is how a person's own key goes out (personalLLM), or a test's `fetch`.
 */
export function anthropicLLM(apiKey: string, model: string, opts: Pick<Wire, 'fetch' | 'own'> = {}): LLM {
  const options: ClientOptions = { apiKey, maxRetries: 3 };

  if (opts.fetch) options.fetch = opts.fetch;

  if (opts.own) Object.assign(options, { baseURL: 'https://api.anthropic.com', authToken: null, logLevel: 'off' });
  const client = new Anthropic(options);
  let fallbacks = !/haiku/i.test(model);

  return {
    label: 'Claude',
    model,
    async json({ label, system, prompt, schema }) {
      const params = {
        model,
        max_tokens: 64000,
        thinking: { type: 'adaptive' as const },
        system: system.map((text, i): Anthropic.TextBlockParam => (i === system.length - 1 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text })),
        messages: [{ role: 'user' as const, content: prompt }],
        output_config: { format: { type: 'json_schema' as const, schema } },
      };

      let msg: Anthropic.Beta.BetaMessage | Anthropic.Message;

      try {
        msg = fallbacks
          ? await client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
          : await client.messages.stream(params).finalMessage();
      } catch (err) {
        if (!fallbacks || !(err instanceof Anthropic.BadRequestError)) throw err;
        fallbacks = false;
        msg = await client.messages.stream(params).finalMessage();
      }

      if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the ${label} request.`);

      if (msg.stop_reason === 'max_tokens') throw new Error(`Claude's answer to the ${label} request was cut off.`);
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

      return JSON.parse(text);
    },
  };
}

// ── OpenAI ─────────────────────────────────────────────────────────────

/** A failed OpenAI request: `status` is unset when the API couldn't be reached. */
export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** OpenAI's error code, e.g. "model_not_found" or "insufficient_quota". */
    readonly code?: string,
    readonly model?: string,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

/** One HTTP POST: status, headers (lower-cased) and body text. Rejects only when the server can't be reached. */
export type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; headers: Record<string, string | undefined>; body: string }>;

/**
 * POST over node:https rather than fetch: fetch gives up after five minutes
 * without response headers, and a long batch can take a reasoning model
 * longer than that to answer. Ours gives up after `timeoutMs`.
 */
export const httpsPost =
  (timeoutMs = 15 * 60_000): Post =>
  (url, headers, body) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const h = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
          resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', fail);
      });

      const timer = setTimeout(() => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);

      function fail(err: Error) {
        clearTimeout(timer);
        reject(err);
      }

      req.on('error', fail);
      req.end(body);
    });

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries the way the Anthropic SDK does: timeouts, conflicts, rate limits and server errors, three more times. */
const retryable = (status: number, code?: string) => status === 408 || status === 409 || (status === 429 && code !== 'insufficient_quota') || status >= 500;

function retryDelay(attempt: number, headers: Record<string, string | undefined>): number {
  const ms = Number(headers['retry-after-ms']);

  if (ms >= 0 && ms < 60_000) return ms;
  const s = Number(headers['retry-after']);

  if (s >= 0 && s < 60) return s * 1000;

  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
}

interface ChatCompletion {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string; code?: string | null; type?: string };
}

/**
 * OpenAI through the Chat Completions API, with plain HTTPS rather than the
 * SDK. Structured output in strict mode, so every answer parses against the
 * request's schema. Without a `model`, it starts with the newest default
 * and moves down DEFAULT_OPENAI_MODELS when the key can't use one; given a
 * list, it moves down that. `post` and `retryDelayMs` are for tests.
 */
export function openaiLLM(apiKey: string, model?: string | string[], opts: { post?: Post; retries?: number; retryDelayMs?: number; log?: (line: string) => void } = {}): LLM {
  const post = opts.post ?? httpsPost();
  const retries = opts.retries ?? 3;
  const log = opts.log ?? ((l: string) => console.log(l));
  const candidates = Array.isArray(model) ? model : model ? [model] : DEFAULT_OPENAI_MODELS;
  let current = 0;

  async function once(model: string, body: string): Promise<ChatCompletion> {
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<Post>>;

      try {
        res = await post(OPENAI_URL, { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body);
      } catch (err) {
        if (attempt < retries) {
          await sleep(opts.retryDelayMs ?? retryDelay(attempt, {}));
          continue;
        }

        throw new OpenAIError(`Couldn't reach the OpenAI API: ${messageOf(err)}`, undefined, undefined, model);
      }

      let data: ChatCompletion = {};

      try {
        data = JSON.parse(res.body);
      } catch {
        // An error page from a proxy; the status says enough.
      }

      if (res.status >= 200 && res.status < 300) return data;
      const code = data.error?.code ?? undefined;

      if (attempt < retries && retryable(res.status, code)) {
        await sleep(opts.retryDelayMs ?? retryDelay(attempt, res.headers));
        continue;
      }

      throw new OpenAIError(data.error?.message || res.body.slice(0, 200) || `HTTP ${res.status}`, res.status, code, model);
    }
  }

  const llm: LLM = {
    label: 'OpenAI',
    get model() {
      return candidates[current];
    },
    async json({ label, system, prompt, schema }) {
      for (;;) {
        const tried = current;
        const model = candidates[tried];

        const body = JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system.join('\n\n') },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
        });

        let data: ChatCompletion;

        try {
          data = await once(model, body);
        } catch (err) {
          const missing = err instanceof OpenAIError && (err.code === 'model_not_found' || err.status === 404);

          if (!missing || tried + 1 >= candidates.length) throw err;

          // Requests in flight together can all miss; the first to come back moves everyone on.
          if (current === tried) {
            current = tried + 1;
            log(`[fiada] OpenAI has no ${model} for this key; using ${candidates[current]}`);
          }

          continue;
        }

        const choice = data.choices?.[0];

        if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error(`OpenAI declined the ${label} request.`);

        if (choice?.finish_reason === 'length') throw new Error(`OpenAI's answer to the ${label} request was cut off.`);
        const text = choice?.message?.content;

        if (!text) throw new Error(`OpenAI sent an empty answer to the ${label} request.`);

        return JSON.parse(text);
      }
    },
  };

  return llm;
}

/**
 * One model shared by many accounts, each allowed `perDay` requests a UTC
 * day, so one person's imports can't spend everyone's key. Past the limit a
 * request fails at once, without reaching the provider, and features fall
 * back as they do without a key's answer.
 */
export class LLMBudget {
  private used = new Map<string, { day: string; n: number }>();

  constructor(
    readonly perDay: number,
    private now: () => number = Date.now,
  ) {}

  /** `llm` as `key` may use it. */
  for(key: string, llm: LLM): LLM {
    const take = () => {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const u = this.used.get(key);
      const n = u?.day === day ? u.n : 0;

      if (n >= this.perDay) throw new Error(`This map has used its ${this.perDay} model requests for today. Summaries and sorting pick up again tomorrow (UTC).`);
      this.used.set(key, { day, n: n + 1 });
    };

    return {
      get label() {
        return llm.label;
      },
      get model() {
        return llm.model;
      },
      async json(req) {
        take();

        return llm.json(req);
      },
    };
  }
}

/**
 * A sentence for people about why a request failed, with anything shaped
 * like a key taken out. `whose` is whose key it was: the indexer's, or the
 * person's own (personalLLM).
 */
export function describeLLMError(cause: unknown, whose: 'indexer' | 'yours' = 'indexer'): string {
  return redactKeys(describe(cause, whose));
}

function describe(cause: unknown, whose: 'indexer' | 'yours'): string {
  const fix = (name: string) => (whose === 'yours' ? 'Replace it under model key in the sidebar.' : `Check ${name} on the indexer.`);

  if (cause instanceof OpenAIError) {
    if (cause.status === undefined) return "Couldn't reach the OpenAI API.";

    if (cause.status === 401) return `The OpenAI API key was rejected. ${fix('OPENAI_API_KEY')}`;

    if (cause.code === 'model_not_found' || cause.status === 404) {
      return `The OpenAI API key can't use ${cause.model ?? 'this model'}.${whose === 'yours' ? '' : ' Set FIADA_LLM_MODEL (or FIADA_SUMMARY_MODEL, for summaries) to a model it has.'}`;
    }

    if (cause.code === 'insufficient_quota') return "The OpenAI API key's account is out of credit. Add some under Billing on platform.openai.com.";

    if (cause.status === 403) return `The OpenAI API refused this key: ${cause.message}`.slice(0, 300);

    if (cause.status === 429) return 'The OpenAI API is rate limiting this key. Try again in a minute.';

    return `The OpenAI API answered ${cause.status}: ${cause.message}`.slice(0, 300);
  }

  if (cause instanceof Anthropic.AuthenticationError) return `The Anthropic API key was rejected. ${fix('ANTHROPIC_API_KEY')}`;

  if (cause instanceof Anthropic.PermissionDeniedError) return "The Anthropic API key can't use this model.";

  if (cause instanceof Anthropic.RateLimitError) return 'The Anthropic API is rate limiting this key. Try again in a minute.';

  if (cause instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";

  if (cause instanceof Anthropic.APIError) return `The Anthropic API answered ${cause.status ?? 'with an error'}: ${cause.message}`.slice(0, 300);

  return messageOf(cause).slice(0, 300);
}
